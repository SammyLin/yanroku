package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeAPI records every request; respond may override the reply per "METHOD path?query".
type fakeAPI struct {
	mu      sync.Mutex
	calls   []string         // "METHOD /path?query"
	bodies  map[string][]any // JSON bodies by call
	respond func(call string, w http.ResponseWriter) bool
}

func newFakeAPI(t *testing.T, respond func(call string, w http.ResponseWriter) bool) (*fakeAPI, *client) {
	f := &fakeAPI{bodies: map[string][]any{}, respond: respond}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	c := newClient(Config{APIBase: srv.URL + "/", AccessClientID: "cid", AccessClientSecret: "sec", RunnerToken: "rt", RunnerName: "mac1"})
	c.backoff = time.Millisecond
	return f, c
}

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	call := r.Method + " " + r.URL.RequestURI()
	b, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.calls = append(f.calls, call)
	var v any
	if json.Unmarshal(b, &v) == nil {
		f.bodies[call] = append(f.bodies[call], v)
	}
	f.mu.Unlock()
	if r.Header.Get("CF-Access-Client-Id") != "cid" || r.Header.Get("CF-Access-Client-Secret") != "sec" || r.Header.Get("Authorization") != "Bearer rt" {
		http.Error(w, "no token", http.StatusForbidden)
		return
	}
	if f.respond != nil && f.respond(call, w) {
		return
	}
	w.Write([]byte(`{}`))
}

func (f *fakeAPI) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

func (f *fakeAPI) body(call string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	if bs := f.bodies[call]; len(bs) > 0 {
		m, _ := bs[len(bs)-1].(map[string]any)
		return m
	}
	return nil
}

func TestClientRetry(t *testing.T) {
	n := 0
	f, c := newFakeAPI(t, func(call string, w http.ResponseWriter) bool {
		switch {
		case strings.HasPrefix(call, "GET /flaky"):
			if n++; n < 3 {
				w.WriteHeader(http.StatusBadGateway)
				return true
			}
			w.Write([]byte(`{"ok":true}`))
		case strings.HasPrefix(call, "GET /bad"):
			http.Error(w, "nope", http.StatusBadRequest)
		case strings.HasPrefix(call, "GET /lost"):
			http.Error(w, "lease", http.StatusConflict)
		case strings.HasPrefix(call, "GET /down"):
			w.WriteHeader(http.StatusServiceUnavailable)
		default:
			return false
		}
		return true
	})
	var out struct{ OK bool }
	if err := c.json(t.Context(), "GET", "/flaky", nil, &out); err != nil || !out.OK || n != 3 {
		t.Fatalf("flaky: err=%v out=%v n=%d", err, out, n)
	}
	if err := c.json(t.Context(), "GET", "/bad", nil, nil); err == nil || !strings.Contains(err.Error(), "400") {
		t.Fatalf("bad: %v", err)
	}
	if err := c.json(t.Context(), "GET", "/lost", nil, nil); !errors.Is(err, errLeaseLost) {
		t.Fatalf("lost: %v", err)
	}
	if err := c.json(t.Context(), "GET", "/down", nil, nil); err == nil {
		t.Fatal("down: want error after retries")
	}
	count := func(p string) int {
		return len(slices.DeleteFunc(f.seen(), func(s string) bool { return s != p }))
	}
	if count("GET /bad") != 1 || count("GET /lost") != 1 || count("GET /down") != c.attempts {
		t.Fatalf("retry counts wrong: %v", f.seen())
	}
}

func fakeACPConfig(t *testing.T) Config {
	t.Setenv("FAKE_ACP_AGENT", "1") // agent replies "你好，世界" (acp_test.go)
	return Config{DataDir: t.TempDir(), LLMProvider: "acp", ACPAgent: os.Args[0] + " -test.run=^$"}
}

func TestRunClaimsSummaries(t *testing.T) {
	cfg := fakeACPConfig(t)
	idleSleep = time.Millisecond
	claims := 0
	f, c := newFakeAPI(t, func(call string, w http.ResponseWriter) bool {
		if call != "POST /api/runner/claim" {
			return false
		}
		claims++
		switch claims {
		case 1:
			w.Write([]byte(`{"job":{"kind":"summary","id":7,"recording_id":3,"template_id":"meeting","language":"en","transcript":"[00:01] A: hi"}}`))
		case 2:
			w.Write([]byte(`{"job":{"kind":"summary","id":8,"template_id":"nope","language":"en"}}`))
		default:
			w.Write([]byte(`{"job":null}`))
		}
		return true
	})
	cfg.APIBase, cfg.RunnerName, cfg.AccessClientID, cfg.AccessClientSecret, cfg.RunnerToken = c.base, c.runner, c.id, c.secret, c.token
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error)
	go func() { done <- run(ctx, cfg) }()
	for !slices.Contains(f.seen(), "POST /api/runner/summaries/8/fail") {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done

	if b := f.body("POST /api/runner/summaries/7/result"); b["content_md"] != "你好，世界" || b["runner"] != "mac1" {
		t.Fatalf("result body: %v", b)
	}
	if b := f.body("POST /api/runner/summaries/8/fail"); !strings.Contains(b["error"].(string), `unknown template "nope"`) {
		t.Fatalf("fail body: %v", b)
	}
}

func TestPublish(t *testing.T) {
	for _, multipart := range []bool{false, true} {
		cfg := fakeACPConfig(t)
		f, c := newFakeAPI(t, func(call string, w http.ResponseWriter) bool {
			switch {
			case call == "POST /api/runner/recordings/5/transcript":
				w.Write([]byte(`{"segment_ids":[101,102,103]}`))
			case strings.HasPrefix(call, "PUT /api/runner/recordings/5/play?part="):
				w.Write([]byte(`{"etag":"e1"}`))
			default:
				return false
			}
			return true
		})
		playSinglePutMax = 90 << 20
		if multipart {
			playSinglePutMax = 0
		}
		play := filepath.Join(t.TempDir(), "play.m4a")
		os.WriteFile(play, []byte("aac"), 0o644)
		tk := &task{job: job{Kind: "recording", ID: 5, Filename: "a.m4a"}, c: c}
		segs := []Segment{{0, 1.5, "今天我們來討論一下下一季的產品規劃"}, {1.5, 3, "好的"}, {3, 4, "沒問題"}}
		if err := publish(t.Context(), cfg, tk, 4, segs, []int{2, 0, 2}, map[int][]float32{2: {0.6, 0.8}}, play); err != nil {
			t.Fatal(err)
		}

		tb := f.body("POST /api/runner/recordings/5/transcript")
		if tb["runner"] != "mac1" || tb["duration_s"] != 4.0 {
			t.Fatalf("transcript body: %v", tb)
		}
		spk, _ := json.Marshal(tb["speakers"])
		seg, _ := json.Marshal(tb["segments"].([]any)[1])
		if string(spk) != `[{"display_name":"Speaker 1","emb_model":"eres2net-large-zh-cn","embedding":[0.6,0.8],"label":"SPEAKER_02"},{"display_name":"Speaker 2","label":"SPEAKER_00"}]` ||
			string(seg) != `{"end_ms":3000,"speaker":1,"start_ms":1500,"text_raw":"好的"}` {
			t.Fatalf("speakers %s segment %s", spk, seg)
		}
		if b := f.body("POST /api/runner/recordings/5/heartbeat"); b["status"] != "cleaning" {
			t.Fatalf("heartbeat: %v", b)
		}
		if b := f.body("POST /api/runner/recordings/5/clean"); b["title"] != "你好，世界" {
			t.Fatalf("clean/title: %v", b)
		}
		want := []string{"PUT /api/runner/recordings/5/play?runner=mac1"}
		if multipart {
			want = []string{"POST /api/runner/recordings/5/play/start?runner=mac1", "PUT /api/runner/recordings/5/play?part=1&runner=mac1", "POST /api/runner/recordings/5/play/complete?runner=mac1"}
			if b, _ := json.Marshal(f.body(want[2])["parts"]); string(b) != `[{"etag":"e1","part":1}]` {
				t.Fatalf("complete parts: %s", b)
			}
		}
		// play.m4a goes up right after the transcript, before cleanup, so it can be played meanwhile
		calls := f.seen()
		if !slices.Equal(calls[:1+len(want)], append([]string{"POST /api/runner/recordings/5/transcript"}, want...)) || calls[len(calls)-1] != "POST /api/runner/recordings/5/done" {
			t.Fatalf("multipart=%v calls: %v", multipart, calls)
		}
	}
}

func TestRunJobLeaseLost(t *testing.T) {
	cfg := Config{DataDir: t.TempDir()}
	f, c := newFakeAPI(t, func(call string, w http.ResponseWriter) bool {
		switch call {
		case "GET /api/runner/recordings/9/source":
			w.Write([]byte("audio bytes"))
		case "POST /api/runner/recordings/9/heartbeat":
			http.Error(w, "lease lost", http.StatusConflict)
		default:
			return false
		}
		return true
	})
	runJob(t.Context(), cfg, c, &job{Kind: "recording", ID: 9, Filename: "x.mp3"})
	calls := f.seen()
	if !slices.Equal(calls, []string{"GET /api/runner/recordings/9/source", "POST /api/runner/recordings/9/heartbeat"}) {
		t.Fatalf("want abort after 409 without fail, got %v", calls)
	}
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "work", "9")); !os.IsNotExist(err) {
		t.Fatalf("work dir not removed: %v", err)
	}
}

func TestRunJobStopped(t *testing.T) {
	cfg := fakeACPConfig(t)
	stopGrace = 50 * time.Millisecond
	f, c := newFakeAPI(t, func(call string, w http.ResponseWriter) bool {
		if call == "POST /api/runner/summaries/4/result" {
			time.Sleep(time.Second) // slow job outlives the grace period
		}
		return false
	})
	stop, cancel := context.WithCancel(t.Context())
	cancel()
	runJob(stop, cfg, c, &job{Kind: "summary", ID: 4, TemplateID: "meeting", Language: "en"})
	if b := f.body("POST /api/runner/summaries/4/defer"); b["seconds"] != 0.0 {
		t.Fatalf("want requeue on stop, defer body: %v (calls %v)", b, f.seen())
	}
	if slices.Contains(f.seen(), "POST /api/runner/summaries/4/fail") {
		t.Fatalf("stopped job must not be failed: %v", f.seen())
	}
}

func TestRunJobStoppedRecordingRequeued(t *testing.T) {
	cfg := Config{DataDir: t.TempDir()}
	stopGrace = 50 * time.Millisecond
	f, c := newFakeAPI(t, func(call string, w http.ResponseWriter) bool {
		if call == "GET /api/runner/recordings/7/source" {
			time.Sleep(time.Second) // still downloading when the grace period ends
			w.Write([]byte("audio"))
			return true
		}
		return false
	})
	stop, cancel := context.WithCancel(t.Context())
	cancel()
	runJob(stop, cfg, c, &job{Kind: "recording", ID: 7, Filename: "x.mp3"})
	if b := f.body("POST /api/runner/recordings/7/defer"); b["seconds"] != 0.0 || b["runner"] != "mac1" {
		t.Fatalf("defer body: %v (calls %v)", b, f.seen())
	}
	if slices.Contains(f.seen(), "POST /api/runner/recordings/7/fail") {
		t.Fatalf("stopped job must not be failed: %v", f.seen())
	}
}

func TestIngestSkipsHidden(t *testing.T) {
	root := t.TempDir()
	for _, n := range []string{"a.m4a", "._a.m4a", ".Trashes/b.m4a", "sub/c.mp3", "sub/._c.mp3"} {
		p := filepath.Join(root, n)
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte("audio"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	f, c := newFakeAPI(t, func(call string, w http.ResponseWriter) bool {
		switch {
		case call == "GET /api/folders", strings.HasPrefix(call, "GET /api/recordings?"):
			w.Write([]byte(`[]`))
		case call == "POST /api/folders":
			w.Write([]byte(`{"id":1}`))
		case call == "POST /api/uploads":
			w.Write([]byte(`{"recording_id":5,"part_size":1048576}`))
		case strings.HasPrefix(call, "PUT /api/uploads/"):
			w.Write([]byte(`{"etag":"e"}`))
		default:
			return false
		}
		return true
	})
	if err := ingest(t.Context(), c, root); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, b := range f.bodies["POST /api/uploads"] {
		names = append(names, b.(map[string]any)["filename"].(string))
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"a.m4a", "c.mp3"}) {
		t.Fatalf("uploaded %v", names)
	}
}
