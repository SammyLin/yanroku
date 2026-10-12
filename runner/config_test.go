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
		{"API_BASE", func(c *Config) { c.APIBase = "https://records.3mi.ai" }}, // loadConfig's default
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
