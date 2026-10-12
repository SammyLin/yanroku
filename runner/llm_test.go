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

func strPtr(s string) *string {
	return &s
}
