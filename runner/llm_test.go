package main

import (
	"testing"
)

func TestSelectModel(t *testing.T) {
	cfg := Config{
		OpenRouterCleanup: "openai/gpt-5.6-luna",
		OpenRouterTitle:   "openai/gpt-5.6-luna",
		OpenRouterSummary: "openai/gpt-5.6-luna",
		OpenRouterAsk:     "openai/gpt-5.6-luna",
		OpenRouterVocab:   "vocab/model",
	}

	tests := []struct {
		name         string
		step         LLMStep
		planOverride *string
		want         string
	}{
		{"cleanup default", StepCleanup, nil, "openai/gpt-5.6-luna"},
		{"title default", StepTitle, nil, "openai/gpt-5.6-luna"},
		{"summary default", StepSummary, nil, "openai/gpt-5.6-luna"},
		{"ask default", StepAsk, nil, "openai/gpt-5.6-luna"},
		{"summary free plan", StepSummary, strPtr("free"), "openai/gpt-5.6-luna"},
		{"summary pro plan", StepSummary, strPtr("pro"), "anthropic/claude-sonnet-5.5"},
		{"cleanup ignores plan", StepCleanup, strPtr("pro"), "openai/gpt-5.6-luna"},
		{"title ignores plan", StepTitle, strPtr("pro"), "openai/gpt-5.6-luna"},
		{"ask ignores plan", StepAsk, strPtr("pro"), "openai/gpt-5.6-luna"},
		{"vocab default", StepVocab, nil, "vocab/model"},
		{"vocab ignores plan", StepVocab, strPtr("pro"), "vocab/model"},
		{"summary unknown plan", StepSummary, strPtr("enterprise"), "openai/gpt-5.6-luna"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := selectModel(cfg, tt.step, tt.planOverride)
			if got != tt.want {
				t.Errorf("selectModel() = %v, want %v", got, tt.want)
			}
		})
	}
}

// TestProSummaryOverridesDefault verifies that Pro plan summary uses Sonnet even though the default is Luna.
func TestProSummaryOverridesDefault(t *testing.T) {
	cfg := Config{
		OpenRouterSummary: "openai/gpt-5.6-luna", // Default is Luna
	}

	freePlan := "free"
	proPlan := "pro"

	// Free plan should use the default (Luna)
	freeModel := selectModel(cfg, StepSummary, &freePlan)
	if freeModel != "openai/gpt-5.6-luna" {
		t.Errorf("Free plan summary = %v, want openai/gpt-5.6-luna", freeModel)
	}

	// Pro plan should override to Sonnet, ignoring the default
	proModel := selectModel(cfg, StepSummary, &proPlan)
	if proModel != "anthropic/claude-sonnet-5.5" {
		t.Errorf("Pro plan summary = %v, want anthropic/claude-sonnet-5.5", proModel)
	}

	// No plan should fall back to default
	noModel := selectModel(cfg, StepSummary, nil)
	if noModel != "openai/gpt-5.6-luna" {
		t.Errorf("No plan summary = %v, want openai/gpt-5.6-luna (default)", noModel)
	}
}

func TestOpenRouterVocabEnv(t *testing.T) {
	t.Setenv("OPENROUTER_VOCAB", "")
	if got := selectModel(loadConfig(), StepVocab, nil); got != "openai/gpt-5.6-luna" {
		t.Errorf("default vocab model = %q", got)
	}
	t.Setenv("OPENROUTER_VOCAB", "acme/vocab-1")
	if got := selectModel(loadConfig(), StepVocab, nil); got != "acme/vocab-1" {
		t.Errorf("OPENROUTER_VOCAB vocab model = %q", got)
	}
}

func strPtr(s string) *string {
	return &s
}
