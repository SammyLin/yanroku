package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// errLeaseLost matches a 409 from the Worker: another runner owns the job now, so abort without failing it.
var errLeaseLost = errors.New("lease lost")

type httpError struct {
	Status     int
	Body       string
	RetryAfter time.Duration // from a Retry-After header in seconds (503 / 429), else 0
}

func (e *httpError) Error() string { return fmt.Sprintf("HTTP %d: %s", e.Status, e.Body) }
func (e *httpError) Is(target error) bool {
	return target == errLeaseLost && e.Status == http.StatusConflict
}

// client talks to the Worker API behind Cloudflare Access (service-token headers) and/or with a runner token (Yanroku Cloud).
type client struct {
	base, id, secret, runner string
	token                    string // Yanroku Cloud runner token (Authorization: Bearer); empty for self-host
	hc                       *http.Client
	attempts                 int
	backoff                  time.Duration // first retry delay, doubled per attempt
	retryAfterUnit           time.Duration // one Retry-After "second" (tests shrink it)
}

// maxRetryAfter caps how long a single Retry-After can park the runner.
const maxRetryAfter = time.Minute

func newClient(cfg Config) *client {
	return &client{
		base: strings.TrimSuffix(cfg.APIBase, "/"), id: cfg.AccessClientID, secret: cfg.AccessClientSecret, runner: cfg.RunnerName, token: cfg.RunnerToken,
		// Access answers a bad token with a redirect to its login page; surface that as an error instead of following it.
		hc:             &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		attempts:       6,
		backoff:        time.Second,
		retryAfterUnit: time.Second,
	}
}

// call sends a request, retrying network errors, 5xx and failed response handling with exponential backoff; a 5xx with
// Retry-After (the Worker's 503 when D1 is unavailable) waits at least that long, capped at maxRetryAfter.
// Non-2xx responses become *httpError (409 matches errLeaseLost). handle, if set, consumes a 2xx response.
func (c *client) call(ctx context.Context, method, path string, body []byte, ctype string, handle func(*http.Response) error) error {
	delay := c.backoff
	for attempt := 1; ; attempt++ {
		err := c.once(ctx, method, path, body, ctype, handle)
		he, isHTTP := errors.AsType[*httpError](err)
		if err == nil || ctx.Err() != nil || (isHTTP && he.Status < 500) || attempt >= c.attempts {
			return err
		}
		wait := delay
		if isHTTP && he.RetryAfter > wait {
			wait = min(he.RetryAfter, maxRetryAfter)
		}
		slog.Warn("api retry", "method", method, "path", path, "attempt", attempt, "wait", wait, "err", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
		delay = min(delay*2, 30*time.Second)
	}
}

func (c *client) once(ctx context.Context, method, path string, body []byte, ctype string, handle func(*http.Response) error) error {
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", ctype)
	}
	if c.id != "" {
		req.Header.Set("CF-Access-Client-Id", c.id)
		req.Header.Set("CF-Access-Client-Secret", c.secret)
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1000))
		he := &httpError{Status: resp.StatusCode, Body: strings.TrimSpace(string(b))}
		if s, err := strconv.Atoi(strings.TrimSpace(resp.Header.Get("Retry-After"))); err == nil && s > 0 {
			he.RetryAfter = time.Duration(s) * c.retryAfterUnit
		}
		return he
	}
	if handle == nil {
		return nil
	}
	return handle(resp)
}

// json sends in (nil = no body) as JSON and decodes the response into out (nil = ignore).
func (c *client) json(ctx context.Context, method, path string, in, out any) error {
	var body []byte
	if in != nil {
		var err error
		if body, err = json.Marshal(in); err != nil {
			return err
		}
	}
	return c.call(ctx, method, path, body, "application/json", decodeInto(out))
}

// put sends raw bytes and decodes the JSON response into out.
func (c *client) put(ctx context.Context, path string, data []byte, out any) error {
	return c.call(ctx, http.MethodPut, path, data, "application/octet-stream", decodeInto(out))
}

func decodeInto(out any) func(*http.Response) error {
	if out == nil {
		return nil
	}
	return func(r *http.Response) error { return json.NewDecoder(r.Body).Decode(out) }
}

// download streams a GET response into dst, starting over on retry.
func (c *client) download(ctx context.Context, path, dst string) error {
	return c.call(ctx, http.MethodGet, path, nil, "", func(r *http.Response) error {
		f, err := os.Create(dst)
		if err != nil {
			return err
		}
		_, err = io.Copy(f, r.Body)
		return errors.Join(err, f.Close())
	})
}

const partSize = 50 << 20 // R2 multipart part size (SPEC)

type part struct {
	Part int    `json:"part"`
	ETag string `json:"etag"`
}

// uploadParts PUTs f in partSize chunks to partPath(n) (n is 1-based) and returns the parts for "complete".
// ponytail: one part in flight; parallelize if uploads become the bottleneck.
func (c *client) uploadParts(ctx context.Context, f *os.File, partPath func(n int) string) ([]part, error) {
	var parts []part
	buf := make([]byte, partSize)
	for n := 1; ; n++ {
		k, err := io.ReadFull(f, buf)
		if k == 0 && errors.Is(err, io.EOF) {
			return parts, nil
		}
		if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, err
		}
		var res struct {
			ETag string `json:"etag"`
		}
		if err := c.put(ctx, partPath(n), buf[:k], &res); err != nil {
			return nil, fmt.Errorf("part %d: %w", n, err)
		}
		parts = append(parts, part{n, res.ETag})
		if k < partSize {
			return parts, nil
		}
	}
}
