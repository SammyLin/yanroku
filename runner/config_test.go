package main

import (
	"strings"
	"testing"
)

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
