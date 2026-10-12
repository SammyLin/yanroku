package main

import (
	"strings"
	"testing"
	"time"
)

func TestValidateProfile(t *testing.T) {
	cloud := Config{STTProvider: "groq", GroqAPIKey: "g", LLMProvider: "openrouter", OpenRouterAPIKey: "o",
		RunnerToken: "r", APIBase: "https://yanroku.app"}
	if err := validateProfile(cloud, "cloud"); err != nil {
		t.Fatalf("full Cloud config: %v", err)
	}
	for _, c := range []struct {
		field string
		edit  func(*Config)
	}{
		{"STT_PROVIDER", func(c *Config) { c.STTProvider = "local" }},
		{"GROQ_API_KEY", func(c *Config) { c.GroqAPIKey = "" }},
		{"LLM_PROVIDER", func(c *Config) { c.LLMProvider = "acp" }},
		{"OPENROUTER_API_KEY", func(c *Config) { c.OpenRouterAPIKey = "" }},
		{"RUNNER_TOKEN", func(c *Config) { c.RunnerToken = "" }},
		{"API_BASE", func(c *Config) { c.APIBase = "https://records.3mi.ai" }}, // a self-host Worker
		{"API_BASE", func(c *Config) { c.APIBase = "" }},
		{"API_BASE", func(c *Config) { c.APIBase = "https://yanroku.app/" }},
		{"CF_ACCESS_CLIENT_ID", func(c *Config) { c.AccessClientID = "id" }},
		{"CF_ACCESS_CLIENT_SECRET", func(c *Config) { c.AccessClientSecret = "s" }},
	} {
		cfg := cloud
		c.edit(&cfg)
		err := validateProfile(cfg, "cloud")
		if err == nil || !strings.Contains(err.Error(), c.field) {
			t.Errorf("%s: got %v", c.field, err)
		}
		if err := validateProfile(cfg, ""); err != nil {
			t.Errorf("%s: empty profile: %v", c.field, err)
		}
	}
	if err := validateProfile(Config{}, ""); err != nil {
		t.Errorf("empty profile, empty config: %v", err)
	}
	if err := validateProfile(cloud, "Cloud"); err == nil {
		t.Error("unknown profile accepted")
	}
}

func TestGroqCacheMaxAgeEnv(t *testing.T) {
	for v, want := range map[string]time.Duration{"": 168 * time.Hour, "1h": time.Hour, "7d": 168 * time.Hour, "-1h": 168 * time.Hour} {
		t.Setenv("GROQ_CACHE_MAX_AGE", v)
		if got := loadConfig().GroqCacheAge; got != want {
			t.Errorf("GROQ_CACHE_MAX_AGE=%q: got %s, want %s", v, got, want)
		}
	}
}

func TestValidateAPIBase(t *testing.T) {
	for _, tc := range []struct {
		in, want, err string
	}{
		{in: "", err: "API_BASE is required"},
		{in: " ", err: "API_BASE is required"},
		{in: "records.3mi.ai", err: "is not a valid URL"},
		{in: "ftp://x.com", err: "is not a valid URL"},
		{in: "http://notes.example.com", err: "is not a valid URL"},
		{in: "https://", err: "is not a valid URL"},
		{in: "https://u:p@x.com", err: "is not a valid URL"},
		{in: "https://x.com/api", err: "is not a valid URL"},
		{in: "https://x.com?a=1", err: "is not a valid URL"},
		{in: "https://x.com#f", err: "is not a valid URL"},
		{in: "https://x .com", err: "is not a valid URL"},
		{in: "https://notes.example.com", want: "https://notes.example.com"},
		{in: "https://notes.example.com/", want: "https://notes.example.com"},
		{in: "https://notes.example.com:8443", want: "https://notes.example.com:8443"},
		{in: "http://localhost:8790", want: "http://localhost:8790"},
		{in: "http://127.0.0.1:8790", want: "http://127.0.0.1:8790"},
		{in: "http://[::1]:8790", want: "http://[::1]:8790"},
	} {
		got, err := validateAPIBase(tc.in)
		if tc.err != "" {
			if err == nil || !strings.Contains(err.Error(), tc.err) {
				t.Errorf("validateAPIBase(%q) err = %v, want containing %q", tc.in, err, tc.err)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("validateAPIBase(%q) = %q, %v; want %q", tc.in, got, err, tc.want)
		}
	}
}

func TestLoadConfigAPIBase(t *testing.T) {
	t.Setenv("API_BASE", "")
	if got := loadConfig().APIBase; got != "" {
		t.Errorf("unset API_BASE: got %q, want no default", got)
	}
	t.Setenv("API_BASE", " https://a.example ")
	if got := loadConfig().APIBase; got != "https://a.example" {
		t.Errorf("got %q, want trimmed", got)
	}
}

func TestNeedsAPI(t *testing.T) {
	for cmd, want := range map[string]bool{"run": true, "ingest": true, "voiceprints": true, "models": false, "version": false} {
		if got := needsAPI(cmd); got != want {
			t.Errorf("needsAPI(%q) = %v, want %v", cmd, got, want)
		}
	}
}
