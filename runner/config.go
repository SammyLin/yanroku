package main

import (
	"bufio"
	"cmp"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config is read once at startup from the environment (after loadDotEnv).
type Config struct {
	DataDir      string
	STTProvider  string // "local" or "groq"
	WhisperModel string
	WhisperLang  string // "auto" for detection
	GroqAPIKey   string
	GroqModel    string
	GroqCacheAge time.Duration // groq-cache files older than this are deleted
	Diarize      bool
	NumSpeakers  int // 0 = auto
	ACPAgent     string
	ACPModel     string // ANTHROPIC_MODEL for the agent; a plain alias keeps it off the global "opus[1m]" (needs usage credits)

	LLMProvider       string // "acp" (default) or "openrouter"
	OpenRouterAPIKey  string
	OpenRouterCleanup string // model for cleanup step
	OpenRouterTitle   string // model for title step
	OpenRouterSummary string // model for summary step; overridden per-plan in Cloud mode
	OpenRouterAsk     string // model for ask step
	OpenRouterVocab   string // model for vocab suggestions

	APIBase            string // Worker origin
	AccessClientID     string // Cloudflare Access service token
	AccessClientSecret string
	RunnerToken        string // Yanroku Cloud: sent as Authorization: Bearer
	RunnerName         string
}

func loadConfig() Config {
	dataDir := cmp.Or(os.Getenv("DATA_DIR"), "data")
	n, _ := strconv.Atoi(os.Getenv("NUM_SPEAKERS"))
	host, _ := os.Hostname()
	cacheAge, err := time.ParseDuration(os.Getenv("GROQ_CACHE_MAX_AGE"))
	if err != nil || cacheAge <= 0 {
		cacheAge = 168 * time.Hour
	}
	return Config{
		DataDir:      dataDir,
		STTProvider:  cmp.Or(os.Getenv("STT_PROVIDER"), "local"),
		WhisperModel: cmp.Or(os.Getenv("WHISPER_MODEL"), filepath.Join(dataDir, "models", "ggml-large-v3-turbo.bin")),
		WhisperLang:  cmp.Or(os.Getenv("WHISPER_LANG"), "zh"),
		GroqAPIKey:   os.Getenv("GROQ_API_KEY"),
		GroqModel:    cmp.Or(os.Getenv("GROQ_MODEL"), "whisper-large-v3"),
		GroqCacheAge: cacheAge,
		Diarize:      os.Getenv("DIARIZE") != "0",
		NumSpeakers:  n,
		ACPAgent:     cmp.Or(os.Getenv("ACP_AGENT"), "claude-agent-acp"),
		ACPModel:     cmp.Or(os.Getenv("ACP_MODEL"), "opus"),

		LLMProvider:       cmp.Or(os.Getenv("LLM_PROVIDER"), "acp"),
		OpenRouterAPIKey:  os.Getenv("OPENROUTER_API_KEY"),
		OpenRouterCleanup: cmp.Or(os.Getenv("OPENROUTER_CLEANUP"), "openai/gpt-5.6-luna"),
		OpenRouterTitle:   cmp.Or(os.Getenv("OPENROUTER_TITLE"), "openai/gpt-5.6-luna"),
		OpenRouterSummary: cmp.Or(os.Getenv("OPENROUTER_SUMMARY"), "openai/gpt-5.6-luna"),
		OpenRouterAsk:     cmp.Or(os.Getenv("OPENROUTER_ASK"), "openai/gpt-5.6-luna"),
		OpenRouterVocab:   cmp.Or(os.Getenv("OPENROUTER_VOCAB"), "openai/gpt-5.6-luna"),

		APIBase:            cmp.Or(os.Getenv("API_BASE"), "https://records.3mi.ai"),
		AccessClientID:     os.Getenv("CF_ACCESS_CLIENT_ID"),
		AccessClientSecret: os.Getenv("CF_ACCESS_CLIENT_SECRET"),
		RunnerToken:        os.Getenv("RUNNER_TOKEN"),
		RunnerName:         cmp.Or(os.Getenv("RUNNER_NAME"), host),
	}
}

// cloudAPIBase is the only API_BASE a RUNNER_PROFILE=cloud runner accepts.
const cloudAPIBase = "https://yanroku.app"

// validateProfile checks cfg against RUNNER_PROFILE. "" accepts anything; "cloud" requires Groq STT, OpenRouter LLM,
// a runner token, the Cloud API_BASE and no Cloudflare Access credentials, so a Cloud runner cannot fall back to
// local providers or post to a self-host Worker.
func validateProfile(cfg Config, profile string) error {
	switch profile {
	case "":
		return nil
	case "cloud":
	default:
		return fmt.Errorf("unknown RUNNER_PROFILE %q (want empty or cloud)", profile)
	}
	var errs []error
	if cfg.STTProvider != "groq" {
		errs = append(errs, fmt.Errorf("STT_PROVIDER must be groq, got %q", cfg.STTProvider))
	}
	if cfg.GroqAPIKey == "" {
		errs = append(errs, errors.New("GROQ_API_KEY is empty"))
	}
	if cfg.LLMProvider != "openrouter" {
		errs = append(errs, fmt.Errorf("LLM_PROVIDER must be openrouter, got %q", cfg.LLMProvider))
	}
	if cfg.OpenRouterAPIKey == "" {
		errs = append(errs, errors.New("OPENROUTER_API_KEY is empty"))
	}
	if cfg.RunnerToken == "" {
		errs = append(errs, errors.New("RUNNER_TOKEN is empty"))
	}
	if cfg.APIBase != cloudAPIBase {
		errs = append(errs, fmt.Errorf("API_BASE must be %s, got %q", cloudAPIBase, cfg.APIBase))
	}
	if cfg.AccessClientID != "" {
		errs = append(errs, errors.New("CF_ACCESS_CLIENT_ID must be empty"))
	}
	if cfg.AccessClientSecret != "" {
		errs = append(errs, errors.New("CF_ACCESS_CLIENT_SECRET must be empty"))
	}
	if len(errs) > 0 {
		return fmt.Errorf("RUNNER_PROFILE=cloud: %w", errors.Join(errs...))
	}
	return nil
}

// loadDotEnv sets KEY=VALUE pairs from path without overriding variables already set.
func loadDotEnv(path string) error {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(strings.TrimPrefix(line, "export "), "=")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
			v = v[1 : len(v)-1]
		}
		if _, set := os.LookupEnv(k); !set {
			os.Setenv(k, v)
		}
	}
	return sc.Err()
}
