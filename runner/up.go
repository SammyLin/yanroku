package main

import (
	"bytes"
	"cmp"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// `yanroku up`: local mode, no Cloudflare. Starts the web server (node web/local/main.ts: the same Worker code on
// node:sqlite + files) and runs this runner against it with a token generated for this start.
// Listens on 127.0.0.1 unless LOCAL_HOST / --host says otherwise; anything but loopback needs LOCAL_PASSWORD.

const (
	defaultLocalPort = 8780
	minNode          = "22.18" // node:sqlite, type stripping and module.registerHooks without flags (23.x: 23.6)
	webStartTimeout  = 60 * time.Second
)

type upOptions struct {
	host     string
	port     int
	web      string // the web/ directory
	password string
}

func isLoopbackHost(h string) bool {
	h = strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(h, "["), "]"))
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// parseUp reads flags over LOCAL_HOST / LOCAL_PORT / LOCAL_PASSWORD / YANROKU_WEB; exe locates the default web/ (../web).
func parseUp(args []string, getenv func(string) string, exe string) (upOptions, error) {
	o := upOptions{password: getenv("LOCAL_PASSWORD")}
	port := defaultLocalPort
	if p := getenv("LOCAL_PORT"); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil {
			return o, fmt.Errorf("LOCAL_PORT %q is not a number", p)
		}
		port = n
	}
	fs := flag.NewFlagSet("up", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&o.host, "host", cmp.Or(getenv("LOCAL_HOST"), "127.0.0.1"), "address to listen on")
	fs.IntVar(&o.port, "port", port, "port to listen on")
	if err := fs.Parse(args); err != nil {
		return o, fmt.Errorf("%w\nusage: yanroku up [--host 127.0.0.1] [--port %d]", err, defaultLocalPort)
	}
	if fs.NArg() > 0 {
		return o, fmt.Errorf("unexpected argument %q\nusage: yanroku up [--host 127.0.0.1] [--port %d]", fs.Arg(0), defaultLocalPort)
	}
	if o.port < 1 || o.port > 65535 {
		return o, fmt.Errorf("port %d is out of range (1-65535)", o.port)
	}
	if o.host == "" {
		return o, errors.New("host is empty")
	}
	if !isLoopbackHost(o.host) && o.password == "" {
		return o, fmt.Errorf("listening on %s opens Yanroku to other devices: set LOCAL_PASSWORD in .env first (or keep the default --host 127.0.0.1)", o.host)
	}
	o.web = cmp.Or(getenv("YANROKU_WEB"), filepath.Join(filepath.Dir(exe), "..", "web"))
	return o, nil
}

var nodeVersionRE = regexp.MustCompile(`^v(\d+)\.(\d+)`)

// nodeVersionOK reports whether `node --version` output is a Node that runs web/local unflagged: 22.18+, 23.6+ or 24+.
func nodeVersionOK(out string) bool {
	m := nodeVersionRE.FindStringSubmatch(strings.TrimSpace(out))
	if m == nil {
		return false
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	return major >= 24 || major == 23 && minor >= 6 || major == 22 && minor >= 18
}

// webEnv is the environment the web server gets: what node needs plus the server's own settings, not the runner's keys.
func webEnv(environ []string, token string) []string {
	keep := map[string]bool{"PATH": true, "HOME": true, "TMPDIR": true, "LANG": true, "LC_ALL": true, "TZ": true, "LOCAL_PASSWORD": true,
		"TRANSFER_ENABLED": true, "VAPID_PUBLIC_KEY": true, "VAPID_PRIVATE_KEY": true, "VAPID_SUBJECT": true,
		"VOICE_MATCH_THRESHOLD": true, "VOICE_SUGGEST_THRESHOLD": true}
	var env []string
	for _, kv := range environ {
		if k, _, _ := strings.Cut(kv, "="); keep[k] {
			env = append(env, kv)
		}
	}
	return append(env, "YANROKU_RUNNER_TOKEN="+token, "YANROKU_PARENT_PIPE=1")
}

// lineWriter writes each line to w with prefix; a line "yanroku: listening <port>" goes to ready instead (once).
type lineWriter struct {
	w      io.Writer
	prefix string
	ready  chan<- int
	buf    []byte
}

func (l *lineWriter) Write(p []byte) (int, error) {
	l.buf = append(l.buf, p...)
	for {
		i := bytes.IndexByte(l.buf, '\n')
		if i < 0 {
			return len(p), nil
		}
		line := string(l.buf[:i])
		l.buf = l.buf[i+1:]
		if rest, ok := strings.CutPrefix(line, "yanroku: listening "); ok && l.ready != nil {
			if n, err := strconv.Atoi(rest); err == nil {
				l.ready <- n
				l.ready = nil
				continue
			}
		}
		fmt.Fprintln(l.w, l.prefix+line)
	}
}

func up(ctx context.Context, cfg Config, args []string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	o, err := parseUp(args, os.Getenv, exe)
	if err != nil {
		return err
	}
	main := filepath.Join(o.web, "local", "main.ts")
	if _, err := os.Stat(main); err != nil {
		return fmt.Errorf("web server not found at %s: run yanroku from the repo's runner/ directory, or set YANROKU_WEB to the repo's web/ directory", main)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return fmt.Errorf("node not found: install Node.js %s or newer (brew install node)", minNode)
	}
	if out, err := exec.CommandContext(ctx, node, "--version").Output(); err != nil || !nodeVersionOK(string(out)) {
		return fmt.Errorf("Node.js %s or newer is required (found %s): brew upgrade node", minNode, cmp.Or(strings.TrimSpace(string(out)), "unknown version"))
	}
	dataDir, err := filepath.Abs(filepath.Join(cfg.DataDir, "web"))
	if err != nil {
		return err
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	token := hex.EncodeToString(b)

	ready := make(chan int, 1)
	cmd := exec.Command(node, main, "--host", o.host, "--port", strconv.Itoa(o.port), "--data", dataDir)
	cmd.Env = webEnv(os.Environ(), token)
	cmd.Stdout = &lineWriter{w: os.Stderr, prefix: "[web] ", ready: ready}
	cmd.Stderr = &lineWriter{w: os.Stderr, prefix: "[web] "}
	stdin, err := cmd.StdinPipe() // closes when this process dies, however it dies: the server then exits too
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start web server: %w", err)
	}
	defer stdin.Close()
	var waitErr error
	done := make(chan struct{}) // closed once the server has exited; waitErr is set by then
	go func() {
		waitErr = cmd.Wait()
		close(done)
	}()

	var port int
	select {
	case port = <-ready:
	case <-done:
		return fmt.Errorf("web server exited during start-up (%v); see the [web] lines above", waitErr)
	case <-time.After(webStartTimeout):
		stopWeb(cmd, done)
		return errors.New("web server did not start within a minute")
	case <-ctx.Done():
		stopWeb(cmd, done)
		return nil
	}
	shown := o.host
	if strings.Contains(shown, ":") {
		shown = "[" + shown + "]"
	}
	slog.Info("Yanroku is running", "url", fmt.Sprintf("http://%s:%d", shown, port), "data", dataDir)
	if !isLoopbackHost(o.host) {
		slog.Warn("other devices can reach this server (password required); browsers only allow recording over HTTPS or on localhost")
	}

	cfg.APIBase = fmt.Sprintf("http://127.0.0.1:%d", port)
	cfg.RunnerToken, cfg.AccessClientID, cfg.AccessClientSecret = token, "", ""
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-done: // the server died: stop the runner too
			cancel()
		case <-runCtx.Done():
		}
	}()
	runErr := run(runCtx, cfg) // on shutdown it hands the current job back, so the server stops after it
	select {
	case <-done:
		if ctx.Err() == nil {
			return fmt.Errorf("web server stopped (%v); see the [web] lines above", waitErr)
		}
	default:
		stopWeb(cmd, done)
	}
	return runErr
}

// stopWeb asks the server to shut down (SIGTERM) and kills it if it is still there after 10 s.
func stopWeb(cmd *exec.Cmd, done <-chan struct{}) {
	cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		cmd.Process.Kill()
		<-done
	}
}
