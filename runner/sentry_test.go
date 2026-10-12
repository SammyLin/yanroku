package main

import (
	"bufio"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseSentryDSN(t *testing.T) {
	d, err := parseSentryDSN("https://abc@o1.ingest.us.sentry.io/42")
	if err != nil || d.endpoint != "https://o1.ingest.us.sentry.io/api/42/envelope/" || d.key != "abc" {
		t.Fatalf("got %+v, %v", d, err)
	}
	for _, bad := range []string{"https://o1.ingest.us.sentry.io/42", "https://abc@o1.ingest.us.sentry.io/", "::"} {
		if _, err := parseSentryDSN(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

// An Error-level log becomes one event with the message and attributes; Info does not; no DSN = nothing sent.
func TestSentryHandler(t *testing.T) {
	got := make(chan map[string]any, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/42/envelope/" || !strings.Contains(r.Header.Get("X-Sentry-Auth"), "sentry_key=k") {
			t.Errorf("request %s %s", r.URL.Path, r.Header.Get("X-Sentry-Auth"))
		}
		sc := bufio.NewScanner(r.Body)
		sc.Buffer(nil, 1<<20)
		var lines []string
		for sc.Scan() {
			lines = append(lines, sc.Text())
		}
		var ev map[string]any
		if len(lines) != 3 || json.Unmarshal([]byte(lines[2]), &ev) != nil {
			t.Errorf("envelope: %q", lines)
		}
		got <- ev
	}))
	defer srv.Close()
	defer func(old *slog.Logger) { slog.SetDefault(old); sentryTarget = nil }(slog.Default())

	if err := initSentry(""); err != nil || sentryTarget != nil {
		t.Fatal("empty DSN must stay off")
	}
	if err := initSentry(strings.Replace(srv.URL, "http://", "http://k@", 1) + "/42"); err != nil {
		t.Fatal(err)
	}
	slog.Info("llm request", "step", "cleanup")
	slog.With("kind", "recording").Error("cleanup batch failed", "recording", 7, "err", "OpenRouter HTTP 402")
	select {
	case ev := <-got:
		extra := ev["extra"].(map[string]any)
		if ev["fingerprint"].([]any)[0] != "cleanup batch failed" || extra["recording"] != "7" || extra["kind"] != "recording" ||
			extra["err"] != "OpenRouter HTTP 402" {
			t.Errorf("event %v", ev)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no event")
	}
	select {
	case ev := <-got:
		t.Errorf("Info must not be reported: %v", ev)
	case <-time.After(200 * time.Millisecond):
	}
}
