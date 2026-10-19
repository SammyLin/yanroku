package main

import (
	"bytes"
	"cmp"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Error reporting to Sentry, off unless SENTRY_DSN is set (self-host leaves it empty). Every slog record at Error level,
// and a fatal start-up error, becomes one Sentry event: the log message, its attributes (ids, step, error text) and the
// runner name and build. Nothing else is sent: no transcript, title or audio; the attributes are what the log line shows.
// ponytail: plain HTTP to Sentry's envelope endpoint instead of sentry-go; switch to the SDK if we want tracing.

type sentryDSN struct{ endpoint, key string }

var sentryTarget *sentryDSN

// parseSentryDSN turns https://<key>@<host>/<project> into the envelope URL and public key.
func parseSentryDSN(dsn string) (*sentryDSN, error) {
	u, err := url.Parse(dsn)
	if err != nil || u.User == nil || u.Host == "" {
		return nil, fmt.Errorf("SENTRY_DSN is not a valid DSN")
	}
	project := strings.Trim(u.Path, "/")
	if project == "" {
		return nil, fmt.Errorf("SENTRY_DSN has no project id")
	}
	return &sentryDSN{endpoint: fmt.Sprintf("%s://%s/api/%s/envelope/", u.Scheme, u.Host, project), key: u.User.Username()}, nil
}

// initSentry enables reporting when dsn is set and routes slog through a text handler that also reports errors.
func initSentry(dsn string) error {
	if dsn == "" {
		return nil
	}
	d, err := parseSentryDSN(dsn)
	if err != nil {
		return err
	}
	sentryTarget = d
	// a fresh handler: wrapping slog's default one and making it the default deadlocks (log → slog → log)
	slog.SetDefault(slog.New(sentryHandler{slog.NewTextHandler(os.Stderr, nil), nil}))
	return nil
}

type sentryHandler struct {
	slog.Handler
	attrs []slog.Attr
}

func (h sentryHandler) Handle(ctx context.Context, r slog.Record) error {
	if r.Level >= slog.LevelError {
		extra := map[string]any{}
		for _, a := range h.attrs {
			extra[a.Key] = a.Value.String()
		}
		r.Attrs(func(a slog.Attr) bool { extra[a.Key] = a.Value.String(); return true })
		go reportSentry(r.Message, extra) // never block a job on Sentry
	}
	return h.Handler.Handle(ctx, r)
}

func (h sentryHandler) WithAttrs(as []slog.Attr) slog.Handler {
	return sentryHandler{h.Handler.WithAttrs(as), append(h.attrs[:len(h.attrs):len(h.attrs)], as...)}
}

// sentryEvent builds the event JSON. Grouped by message (e.g. "cleanup batch failed"), so one failing provider is one issue.
func sentryEvent(msg string, extra map[string]any) map[string]any {
	id := make([]byte, 16)
	rand.Read(id)
	rev, _ := buildVersion()
	host, _ := os.Hostname()
	return map[string]any{
		"event_id":    hex.EncodeToString(id),
		"timestamp":   float64(time.Now().UnixMilli()) / 1000,
		"platform":    "go",
		"level":       "error",
		"logger":      "runner",
		"message":     map[string]any{"formatted": msg},
		"fingerprint": []string{msg},
		"release":     "runner@" + rev,
		"server_name": cmp.Or(os.Getenv("RUNNER_NAME"), host),
		"tags":        map[string]string{"profile": os.Getenv("RUNNER_PROFILE")},
		"extra":       extra,
	}
}

// reportSentry sends one event; failures only go to stderr (never back into slog, which would loop).
func reportSentry(msg string, extra map[string]any) {
	d := sentryTarget
	if d == nil {
		return
	}
	ev := sentryEvent(msg, extra)
	evJSON, _ := json.Marshal(ev)
	var body bytes.Buffer
	fmt.Fprintf(&body, `{"event_id":%q}`+"\n"+`{"type":"event","length":%d}`+"\n", ev["event_id"], len(evJSON))
	body.Write(evJSON)
	body.WriteByte('\n')
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, d.endpoint, &body)
	req.Header.Set("Content-Type", "application/x-sentry-envelope")
	req.Header.Set("X-Sentry-Auth", "Sentry sentry_version=7, sentry_client=yanroku-runner/1, sentry_key="+d.key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, "sentry:", err)
		return
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "sentry: HTTP", resp.StatusCode)
	}
}
