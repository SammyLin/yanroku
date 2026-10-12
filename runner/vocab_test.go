package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
)

func TestParseVocab(t *testing.T) {
	terms := func(ts []vocabTerm) []string {
		var out []string
		for _, x := range ts {
			out = append(out, x.Term)
		}
		return out
	}
	for _, c := range []struct {
		reply string
		want  []string
	}{
		{`[{"term":"EnergyQ","misheard":["能源Q"],"kind":"product"}]`, []string{"EnergyQ"}},
		{"好的，結果如下：\n```json\n[{\"term\": \"NHQ\"}, {\"term\": \"S&OR\"}]\n```", []string{"NHQ", "S&OR"}},
		{`前面[有括號]的說明 [{"term":"NHQ"}]`, []string{"NHQ"}},                                                      // prose with brackets first
		{`[{"term":"delta"},{"term":"Blocked"},{"term":" "},{"term":"NHQ"},{"term":"nhq"}]`, []string{"NHQ"}}, // vocab/skip (any case), empty, dupes
		{`[{"term":"` + strings.Repeat("長", 51) + `"},{"term":"OK"}]`, []string{"OK"}},                        // over 50 chars
		{"[]", nil},
		{"沒有建議", nil},
	} {
		if got := terms(parseVocab(c.reply, []string{"Delta"}, []string{"blocked"})); !slices.Equal(got, c.want) {
			t.Errorf("parseVocab(%q) = %v, want %v", c.reply, got, c.want)
		}
	}
	got := parseVocab(`[{"term":"EnergyQ","misheard":[" 能源Q ","EnergyQ",""]}]`, nil, nil)
	if len(got) != 1 || !slices.Equal(got[0].Misheard, []string{"能源Q"}) {
		t.Errorf("misheard not cleaned: %+v", got)
	}
	var many strings.Builder
	many.WriteString("[")
	for i := range 40 {
		if i > 0 {
			many.WriteString(",")
		}
		many.WriteString(`{"term":"T` + strings.Repeat("x", i) + `"}`)
	}
	many.WriteString("]")
	if n := len(parseVocab(many.String(), nil, nil)); n != vocabMaxTerms {
		t.Errorf("cap: got %d terms, want %d", n, vocabMaxTerms)
	}
}

// vocabServer fakes both OpenRouter (/or) and the Worker's runner API, recording each request body by path.
func vocabServer(t *testing.T, reply string) (*httptest.Server, map[string][]string) {
	t.Helper()
	var mu sync.Mutex
	got := map[string][]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		got[r.URL.Path] = append(got[r.URL.Path], string(b))
		mu.Unlock()
		if r.URL.Path == "/or" {
			json.NewEncoder(w).Encode(map[string]any{
				"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": reply}}},
				"usage":   map[string]any{"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "total_cost": 0.001},
			})
			return
		}
		w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)
	old := openRouterAPI
	openRouterAPI = srv.URL + "/or"
	t.Cleanup(func() { openRouterAPI = old })
	return srv, got
}

func TestSuggestVocabOpenRouter(t *testing.T) {
	srv, got := vocabServer(t, `[{"term":"EnergyQ","misheard":["能源Q"],"kind":"product"}]`)
	dataDir := t.TempDir()
	cfg := Config{DataDir: dataDir, APIBase: srv.URL, LLMProvider: "openrouter", OpenRouterAPIKey: "k",
		OpenRouterVocab: "acme/vocab-1", ACPAgent: "/nonexistent/acp-agent"}
	tk := &task{job: job{Kind: "vocab", ID: 7, Recordings: []vocabRec{{ID: 1, Title: "t", Text: "EnergyQ"}}}, c: newClient(cfg)}
	if err := suggestVocab(t.Context(), cfg, tk); err != nil {
		t.Fatal(err)
	}
	if n := len(got["/or"]); n != 1 {
		t.Fatalf("OpenRouter requests = %d, want 1", n)
	}
	var req openRouterRequest
	if err := json.Unmarshal([]byte(got["/or"][0]), &req); err != nil {
		t.Fatal(err)
	}
	if req.Model != "acme/vocab-1" || req.Provider == nil || req.Provider.DataCollection != "deny" ||
		!strings.Contains(got["/or"][0], `"provider":{"data_collection":"deny"}`) {
		t.Errorf("OpenRouter body = %s", got["/or"][0])
	}
	if _, err := os.Stat(filepath.Join(dataDir, "acp")); !os.IsNotExist(err) {
		t.Errorf("ACP was invoked (data/acp exists: %v)", err)
	}
	if r := got["/api/runner/vocab/7/result"]; len(r) != 1 || !strings.Contains(r[0], `"term":"EnergyQ"`) {
		t.Errorf("result posts = %v", r)
	}
	if u := got["/api/runner/vocab/7/usage"]; len(u) != 1 || !strings.Contains(u[0], `"step":"vocab"`) ||
		!strings.Contains(u[0], `"provider":"openrouter"`) || !strings.Contains(u[0], `"model":"acme/vocab-1"`) {
		t.Errorf("usage posts = %v", u)
	}
}

func TestSuggestVocabACP(t *testing.T) {
	srv, got := vocabServer(t, "[]")
	cfg := fakeACPConfig(t)
	cfg.APIBase = srv.URL
	tk := &task{job: job{Kind: "vocab", ID: 8}, c: newClient(cfg)}
	if err := suggestVocab(t.Context(), cfg, tk); err != nil {
		t.Fatal(err)
	}
	if n := len(got["/or"]); n != 0 {
		t.Errorf("OpenRouter requests = %d, want 0", n)
	}
	if r := got["/api/runner/vocab/8/result"]; len(r) != 1 {
		t.Errorf("result posts = %v", r)
	}
	if u := got["/api/runner/vocab/8/usage"]; len(u) != 1 || !strings.Contains(u[0], `"provider":"acp"`) {
		t.Errorf("usage posts = %v", u)
	}
}
