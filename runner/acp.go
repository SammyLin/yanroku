package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ponytail: global lock, one agent process per call; pool sessions if throughput matters.
var acpMu sync.Mutex

// Plain text-in/text-out use; tool calls would only waste time (and get denied anyway).
const acpPreamble = "Answer directly from the text below. Do not use any tools or read/write files.\n\n"

// claude-agent-acp extensions (other agents ignore unknown _meta; verified with codex-acp): no tools, plain system prompt,
// and skip ~/.claude settings so the user's plugins/hooks/CLAUDE.md don't leak into outputs.
var acpMeta = map[string]any{
	"disableBuiltInTools": true,
	"systemPrompt":        "You are a precise assistant for a voice-notes app. Follow the user's formatting instructions exactly.",
	"claudeCode":          map[string]any{"options": map[string]any{"settingSources": []string{}}},
}

const acpTimeout = 10 * time.Minute

type rpcMsg struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

// acpAsk runs one prompt through a fresh ACP agent process and returns the reply text.
func acpAsk(ctx context.Context, cfg Config, prompt string) (string, error) {
	acpMu.Lock()
	defer acpMu.Unlock()

	argv := strings.Fields(cfg.ACPAgent)
	if len(argv) == 0 {
		return "", errors.New("ACP_AGENT is empty")
	}
	cwd, err := filepath.Abs(filepath.Join(cfg.DataDir, "acp"))
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(ctx, acpTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "ANTHROPIC_MODEL="+cfg.ACPModel) // Claude only; codex-acp takes -c model=... in ACP_AGENT
	cmd.WaitDelay = 2 * time.Second
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return "", err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("ACP agent %s: %w", argv[0], err)
	}

	out, err := acpSession(ctx, stdin, bufio.NewReader(stdout), cwd, prompt)
	cmd.Process.Kill()
	cmd.Wait() // also finishes copying stderr
	if err != nil {
		tail := stderr.Bytes()
		tail = tail[max(0, len(tail)-2000):]
		return "", fmt.Errorf("ACP agent %s: %w\n%s", argv[0], err, bytes.TrimSpace(tail))
	}
	return out, nil
}

func acpSession(ctx context.Context, w io.Writer, r *bufio.Reader, cwd, prompt string) (string, error) {
	var chunks strings.Builder
	nextID := 0

	send := func(m map[string]any) error {
		m["jsonrpc"] = "2.0"
		b, err := json.Marshal(m)
		if err != nil {
			return err
		}
		_, err = w.Write(append(b, '\n'))
		return err
	}

	call := func(method string, params any) (json.RawMessage, error) {
		nextID++
		rid := strconv.Itoa(nextID)
		if err := send(map[string]any{"id": nextID, "method": method, "params": params}); err != nil {
			return nil, fmt.Errorf("pipe error in %s: %w", method, err)
		}
		for {
			line, err := r.ReadBytes('\n')
			if err != nil {
				if ctx.Err() != nil {
					return nil, fmt.Errorf("%v in %s", context.Cause(ctx), method)
				}
				return nil, fmt.Errorf("exited during %s", method)
			}
			line = bytes.TrimSpace(line)
			var m rpcMsg
			if !bytes.HasPrefix(line, []byte("{")) || json.Unmarshal(line, &m) != nil {
				continue
			}
			switch {
			case m.Method == "session/update":
				var p struct {
					Update struct {
						SessionUpdate string `json:"sessionUpdate"`
						Content       struct{ Type, Text string }
					}
				}
				json.Unmarshal(m.Params, &p)
				if p.Update.SessionUpdate == "agent_message_chunk" && p.Update.Content.Type == "text" {
					chunks.WriteString(p.Update.Content.Text)
				}
			case m.Method == "session/request_permission" && m.ID != nil:
				err = send(map[string]any{"id": m.ID, "result": map[string]any{"outcome": map[string]any{"outcome": "cancelled"}}})
			case m.Method != "" && m.ID != nil:
				err = send(map[string]any{"id": m.ID, "error": map[string]any{"code": -32601, "message": "Method not found: " + m.Method}})
			case m.Method == "" && string(m.ID) == rid:
				if m.Error != nil {
					return nil, fmt.Errorf("%s error: %s", method, m.Error)
				}
				return m.Result, nil
			}
			if err != nil {
				return nil, fmt.Errorf("pipe error in %s: %w", method, err)
			}
		}
	}

	if _, err := call("initialize", map[string]any{
		"protocolVersion":    1,
		"clientCapabilities": map[string]any{"fs": map[string]any{"readTextFile": false, "writeTextFile": false}, "terminal": false},
	}); err != nil {
		return "", err
	}
	res, err := call("session/new", map[string]any{"cwd": cwd, "mcpServers": []any{}, "_meta": acpMeta})
	if err != nil {
		return "", err
	}
	var sess struct{ SessionID string }
	json.Unmarshal(res, &sess)
	res, err = call("session/prompt", map[string]any{
		"sessionId": sess.SessionID,
		"prompt":    []any{map[string]any{"type": "text", "text": acpPreamble + prompt}},
	})
	if err != nil {
		return "", err
	}
	var pr struct{ StopReason string }
	json.Unmarshal(res, &pr)
	if pr.StopReason != "" && pr.StopReason != "end_turn" {
		return "", fmt.Errorf("stopReason %s", pr.StopReason)
	}
	return strings.TrimSpace(chunks.String()), nil
}
