package main

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestIsLoopbackHost(t *testing.T) {
	for _, h := range []string{"127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"} {
		if !isLoopbackHost(h) {
			t.Errorf("%s: want loopback", h)
		}
	}
	for _, h := range []string{"0.0.0.0", "::", "192.168.1.5", "localhost.example.com", "example.com"} {
		if isLoopbackHost(h) {
			t.Errorf("%s: want not loopback", h)
		}
	}
}

func TestParseUp(t *testing.T) {
	env := func(kv map[string]string) func(string) string { return func(k string) string { return kv[k] } }
	o, err := parseUp(nil, env(nil), "/opt/yanroku/runner/yanroku")
	if err != nil || o.host != "127.0.0.1" || o.port != defaultLocalPort || o.web != "/opt/yanroku/web" {
		t.Fatalf("defaults: %+v %v", o, err)
	}
	// .env values, then flags over them
	e := env(map[string]string{"LOCAL_HOST": "0.0.0.0", "LOCAL_PORT": "9000", "LOCAL_PASSWORD": "pw", "YANROKU_WEB": "/w"})
	if o, err = parseUp(nil, e, "/x/yanroku"); err != nil || o.host != "0.0.0.0" || o.port != 9000 || o.password != "pw" || o.web != "/w" {
		t.Fatalf("env: %+v %v", o, err)
	}
	if o, err = parseUp([]string{"--host", "127.0.0.1", "--port", "9100"}, e, "/x/yanroku"); err != nil || o.host != "127.0.0.1" || o.port != 9100 {
		t.Fatalf("flags: %+v %v", o, err)
	}
	// not loopback without a password: refused, with the fix in the message
	if _, err = parseUp([]string{"--host", "0.0.0.0"}, env(nil), "/x/yanroku"); err == nil || !strings.Contains(err.Error(), "LOCAL_PASSWORD") {
		t.Fatalf("no password: %v", err)
	}
	for _, args := range [][]string{{"--port", "0"}, {"--port", "70000"}, {"--nope"}, {"extra"}, {"--host", ""}} {
		if _, err := parseUp(args, env(nil), "/x/yanroku"); err == nil {
			t.Errorf("%v: want error", args)
		}
	}
	if _, err := parseUp(nil, env(map[string]string{"LOCAL_PORT": "abc"}), "/x/yanroku"); err == nil {
		t.Error("LOCAL_PORT=abc: want error")
	}
}

func TestNodeVersionOK(t *testing.T) {
	for v, want := range map[string]bool{"v22.18.0\n": true, "v22.20.1": true, "v24.1.0": true, "v26.4.0": true, "v22.17.9": false, "v23.5.0": false, "v23.6.0": true, "v20.19.0": false, "": false, "nope": false} {
		if got := nodeVersionOK(v); got != want {
			t.Errorf("%q: got %v want %v", v, got, want)
		}
	}
}

func TestWebEnv(t *testing.T) {
	env := webEnv([]string{"PATH=/bin", "HOME=/h", "GROQ_API_KEY=secret", "OPENROUTER_API_KEY=k", "LOCAL_PASSWORD=pw", "TRANSFER_ENABLED=1", "RUNNER_TOKEN=x"}, "tok")
	want := []string{"PATH=/bin", "HOME=/h", "LOCAL_PASSWORD=pw", "TRANSFER_ENABLED=1", "YANROKU_RUNNER_TOKEN=tok", "YANROKU_PARENT_PIPE=1"}
	if !slices.Equal(env, want) {
		t.Fatalf("got %v want %v", env, want)
	}
}

func TestLineWriter(t *testing.T) {
	var out bytes.Buffer
	ready := make(chan int, 1)
	w := &lineWriter{w: &out, prefix: "[web] ", ready: ready}
	for _, chunk := range []string{"applied migr", "ations: 0001\nyanroku: listening 8", "780\nhello\nyanroku: listening 1\npartial"} {
		w.Write([]byte(chunk))
	}
	if p := <-ready; p != 8780 {
		t.Fatalf("port %d", p)
	}
	// only the first listening line is consumed; an unfinished line waits for its newline
	if got := out.String(); got != "[web] applied migrations: 0001\n[web] hello\n[web] yanroku: listening 1\n" {
		t.Fatalf("got %q", got)
	}
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func needNode(t *testing.T) {
	out, err := exec.Command("node", "--version").Output()
	if err != nil || !nodeVersionOK(string(out)) {
		t.Skip("needs Node.js " + minNode + "+")
	}
}

// End to end with the real web server: up serves the UI and API, the runner registers, and a cancel (Ctrl-C) stops both.
func TestUpRunsWebAndRunner(t *testing.T) {
	needNode(t)
	web, _ := filepath.Abs("../web")
	port := freePort(t)
	t.Setenv("YANROKU_WEB", web)
	t.Setenv("LOCAL_HOST", "")
	t.Setenv("LOCAL_PASSWORD", "")
	cfg := Config{DataDir: t.TempDir(), RunnerName: "up-test", STTProvider: "local"}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errc := make(chan error, 1)
	go func() { errc <- up(ctx, cfg, []string{"--port", fmt.Sprint(port)}) }()

	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	deadline := time.Now().Add(30 * time.Second)
	var runners string
	for time.Now().Before(deadline) && !strings.Contains(runners, "up-test") {
		if r, err := http.Get(base + "/api/runners"); err == nil {
			var b bytes.Buffer
			b.ReadFrom(r.Body)
			r.Body.Close()
			runners = b.String()
		}
		time.Sleep(200 * time.Millisecond)
	}
	if !strings.Contains(runners, "up-test") {
		t.Fatalf("runner never registered: %q", runners)
	}
	if r, err := http.Get(base + "/"); err != nil || r.StatusCode != 200 {
		t.Fatalf("UI: %v %v", r, err)
	}
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "web", "yanroku.db")); err != nil {
		t.Fatalf("database not in DATA_DIR/web: %v", err)
	}

	cancel()
	select {
	case err := <-errc:
		if err != nil {
			t.Fatalf("up: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("up did not stop")
	}
	if _, err := http.Get(base + "/api/config"); err == nil {
		t.Fatal("web server still answering after up returned")
	}
}

// A web server that dies takes up down with it, with an error that points at its output.
func TestUpStopsWhenWebDies(t *testing.T) {
	needNode(t)
	web := t.TempDir()
	os.MkdirAll(filepath.Join(web, "local"), 0o755)
	os.WriteFile(filepath.Join(web, "local", "main.ts"), []byte(`console.log("yanroku: listening 1"); setTimeout(() => process.exit(3), 300);`), 0o644)
	t.Setenv("YANROKU_WEB", web)
	t.Setenv("LOCAL_HOST", "")
	errc := make(chan error, 1)
	go func() { errc <- up(context.Background(), Config{DataDir: t.TempDir(), RunnerName: "x"}, nil) }()
	select {
	case err := <-errc:
		if err == nil || !strings.Contains(err.Error(), "web server stopped") {
			t.Fatalf("got %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("up kept running after the web server died")
	}
}

func TestUpMissingWeb(t *testing.T) {
	t.Setenv("YANROKU_WEB", t.TempDir())
	t.Setenv("LOCAL_HOST", "")
	if err := up(context.Background(), Config{DataDir: t.TempDir()}, nil); err == nil || !strings.Contains(err.Error(), "YANROKU_WEB") {
		t.Fatalf("got %v", err)
	}
}
