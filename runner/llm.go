package main

import (
	"cmp"
	"context"
	"fmt"
	"log/slog"
)

// LLMStep represents a pipeline step that uses LLM.
type LLMStep string

const (
	StepCleanup LLMStep = "cleanup"
	StepTitle   LLMStep = "title"
	StepSummary LLMStep = "summary"
	StepAsk     LLMStep = "ask"
	StepVocab   LLMStep = "vocab"
)

// LLMUsage tracks token and cost information for an LLM call.
type LLMUsage struct {
	PromptTokens     int
	CompletionTokens int
	TotalTokens      int
	TotalCost        float64 // USD
	Model            string
	Provider         string
}

// llmAsk routes an LLM request to the appropriate provider based on config and step.
// For Cloud mode (via job settings), it may override the model based on the user's plan.
func llmAsk(ctx context.Context, cfg Config, step LLMStep, prompt string, planOverride *string) (string, *LLMUsage, error) {
	provider := cmp.Or(cfg.LLMProvider, "acp") // a Config not built by loadConfig has it empty
	model := selectModel(cfg, step, planOverride)

	slog.Info("llm request", "provider", provider, "step", step, "model", model)

	switch provider {
	case "openrouter":
		if cfg.OpenRouterAPIKey == "" {
			return "", nil, fmt.Errorf("OpenRouter selected but OPENROUTER_API_KEY is not set")
		}
		reply, usage, err := openRouterAsk(ctx, cfg, model, prompt)
		if err != nil {
			return "", nil, err
		}
		var llmUsage *LLMUsage
		if usage != nil {
			llmUsage = &LLMUsage{
				PromptTokens:     usage.PromptTokens,
				CompletionTokens: usage.CompletionTokens,
				TotalTokens:      usage.TotalTokens,
				TotalCost:        usage.TotalCost,
				Model:            model,
				Provider:         "openrouter",
			}
		}
		return reply, llmUsage, nil

	case "acp":
		if cfg.ACPAgent == "" {
			return "", nil, fmt.Errorf("ACP selected but ACP_AGENT is not configured")
		}
		reply, err := acpAsk(ctx, cfg, prompt)
		if err != nil {
			return "", nil, err
		}
		// ACP doesn't provide usage info
		return reply, &LLMUsage{Provider: "acp", Model: cfg.ACPModel}, nil

	default:
		return "", nil, fmt.Errorf("unknown LLM provider: %s", provider)
	}
}

// selectModel chooses the model for a step, with optional plan-based override for Cloud mode.
func selectModel(cfg Config, step LLMStep, planOverride *string) string {
	// Plan-based override for summary step in Cloud mode
	if step == StepSummary && planOverride != nil {
		switch *planOverride {
		case "free":
			return "openai/gpt-5.6-luna"
		case "pro":
			return "anthropic/claude-sonnet-5.5"
		}
	}

	// Default models from config
	switch step {
	case StepCleanup:
		return cfg.OpenRouterCleanup
	case StepTitle:
		return cfg.OpenRouterTitle
	case StepSummary:
		return cfg.OpenRouterSummary
	case StepAsk:
		return cfg.OpenRouterAsk
	case StepVocab:
		return cfg.OpenRouterVocab
	default:
		return cfg.OpenRouterSummary
	}
}
