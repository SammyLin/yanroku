package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

const openRouterAPI = "https://openrouter.ai/api/v1/chat/completions"
const openRouterTimeout = 10 * time.Minute

type openRouterRequest struct {
	Model    string                   `json:"model"`
	Messages []openRouterMessage      `json:"messages"`
	Provider *openRouterProviderPrefs `json:"provider,omitempty"`
}

type openRouterMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type openRouterProviderPrefs struct {
	DataCollection string `json:"data_collection"`
}

type openRouterResponse struct {
	ID      string              `json:"id"`
	Choices []openRouterChoice  `json:"choices"`
	Usage   *openRouterUsage    `json:"usage,omitempty"`
	Error   *openRouterAPIError `json:"error,omitempty"`
}

type openRouterChoice struct {
	Message openRouterMessage `json:"message"`
}

type openRouterUsage struct {
	PromptTokens     int     `json:"prompt_tokens"`
	CompletionTokens int     `json:"completion_tokens"`
	TotalTokens      int     `json:"total_tokens"`
	TotalCost        float64 `json:"total_cost"` // USD
}

type openRouterAPIError struct {
	Message string `json:"message"`
	Code    int    `json:"code"`
}

// openRouterAsk sends a prompt to OpenRouter and returns the reply text and usage info.
func openRouterAsk(ctx context.Context, cfg Config, model, prompt string) (string, *openRouterUsage, error) {
	if cfg.OpenRouterAPIKey == "" {
		return "", nil, errors.New("OPENROUTER_API_KEY is empty")
	}

	ctx, cancel := context.WithTimeout(ctx, openRouterTimeout)
	defer cancel()

	reqBody := openRouterRequest{
		Model: model,
		Messages: []openRouterMessage{
			{Role: "system", Content: "You are a precise assistant for a voice-notes app. Follow the user's formatting instructions exactly."},
			{Role: "user", Content: prompt},
		},
		Provider: &openRouterProviderPrefs{DataCollection: "deny"},
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return "", nil, err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", openRouterAPI, bytes.NewReader(body))
	if err != nil {
		return "", nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.OpenRouterAPIKey)
	req.Header.Set("HTTP-Referer", "https://yanroku.app")
	req.Header.Set("X-Title", "Yanroku")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", nil, fmt.Errorf("OpenRouter request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", nil, fmt.Errorf("OpenRouter read: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", nil, fmt.Errorf("OpenRouter HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var result openRouterResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", nil, fmt.Errorf("OpenRouter parse: %w", err)
	}

	if result.Error != nil {
		return "", nil, fmt.Errorf("OpenRouter API error %d: %s", result.Error.Code, result.Error.Message)
	}

	if len(result.Choices) == 0 {
		return "", nil, errors.New("OpenRouter: no choices in response")
	}

	return result.Choices[0].Message.Content, result.Usage, nil
}
