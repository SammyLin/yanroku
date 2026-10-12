package main

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	vocabMaxTerms = 30
	// ponytail: char budget for one scan's material (CJK ≈ 1 token/char); diffs go in whole, transcripts share the rest
	vocabBudget = 120_000
)

// vocabRec is one recording in a vocab job (POST /api/runner/claim, kind "vocab").
type vocabRec struct {
	ID    int64       `json:"id"`
	Title string      `json:"title"`
	Diffs []vocabDiff `json:"diffs"` // segments where cleanup changed words
	Text  string      `json:"text"`  // cleaned transcript
}

type vocabDiff struct {
	Raw   string `json:"raw"`
	Clean string `json:"clean"`
}

// vocabTerm is one suggestion posted to /api/runner/vocab/{id}/result.
type vocabTerm struct {
	Term     string   `json:"term"`
	Misheard []string `json:"misheard"`
	Kind     string   `json:"kind"`
}

const vocabPrompt = `你在幫使用者整理語音辨識（ASR）用的專有名詞表。這份詞表會放進語音辨識的提示，讓之後的錄音少聽錯。
下面是使用者幾份錄音的資料：「整理前後不同的句子」是語音辨識原文（原）與 AI 整理後（改）的對照，常能看出哪些詞被聽錯；「逐字稿」是整理後的全文。

請找出值得加入詞表的詞，最多 30 個，最重要的放前面：
- 只要專有名詞：產品名、公司／組織名、人名、專案代號、領域術語、縮寫、中英夾雜的詞（例如 EnergyQ、S&OR、Delta）。
- 優先選被聽錯過的詞（「原」裡寫錯、「改」裡修正的），以及在多份錄音反覆出現的詞。
- 不要一般常用詞、不要普通英文單字、不要只出現一次又沒被聽錯的詞。
- 不要已在詞表裡的詞，也不要「不再建議」裡的詞。
- term 用正確寫法（取自「改」或逐字稿）；misheard 列出它在「原」裡被聽成的寫法（沒有就給空陣列）；kind 是 product、company、person、term、other 之一。

只輸出一個 JSON 陣列，不要輸出任何其他文字，例如：
[{"term": "EnergyQ", "misheard": ["能源Q", "Energy Q"], "kind": "product"}]
沒有值得加入的詞就輸出 []。

目前詞表：{vocab}
不再建議：{skip}

{material}`

// suggestVocab runs a vocab job: one LLM call (LLM_PROVIDER) over the scan's recordings, then post the parsed terms.
func suggestVocab(ctx context.Context, cfg Config, t *task) error {
	reply, usage, err := llmAsk(ctx, cfg, StepVocab, vocabPromptFor(t.Vocab, t.Skip, t.Recordings), nil)
	if err != nil {
		return err
	}
	t.recordUsage(ctx, StepVocab, usage)
	terms := parseVocab(reply, t.Vocab, t.Skip)
	slog.Info("vocab: suggestions", "scan", t.ID, "terms", len(terms))
	return t.post(ctx, "result", map[string]any{"terms": terms}, nil)
}

func vocabPromptFor(vocab, skip []string, recs []vocabRec) string {
	list := func(ws []string) string {
		if len(ws) == 0 {
			return "（無）"
		}
		return strings.Join(ws, "、")
	}
	var diffs strings.Builder
	for _, r := range recs {
		for _, d := range r.Diffs {
			fmt.Fprintf(&diffs, "%d|原：%s\n%d|改：%s\n", r.ID, d.Raw, r.ID, d.Clean)
		}
	}
	// transcripts share what the diffs leave of the budget
	per := (vocabBudget - utf8.RuneCountInString(diffs.String())) / max(len(recs), 1)
	var b strings.Builder
	if diffs.Len() > 0 {
		b.WriteString("## 整理前後不同的句子（行首是錄音 id）\n")
		b.WriteString(diffs.String())
		b.WriteString("\n")
	}
	for _, r := range recs {
		text := r.Text
		if utf8.RuneCountInString(text) > per {
			text = string([]rune(text)[:max(per, 0)])
		}
		fmt.Fprintf(&b, "## 逐字稿：錄音 %d「%s」\n%s\n\n", r.ID, r.Title, strings.TrimSpace(text))
	}
	return strings.NewReplacer("{vocab}", list(vocab), "{skip}", list(skip), "{material}", strings.TrimSpace(b.String())).Replace(vocabPrompt)
}

// parseVocab reads the first JSON array of {term, misheard, kind} in reply (fences/prose tolerated) and keeps terms
// that are non-empty, at most 50 characters, not in vocab or skip (case-insensitive) and not repeated; at most vocabMaxTerms.
func parseVocab(reply string, vocab, skip []string) []vocabTerm {
	var items []vocabTerm
	if !firstJSONArray(reply, &items) {
		return []vocabTerm{}
	}
	seen := map[string]bool{}
	for _, w := range slices.Concat(vocab, skip) {
		seen[strings.ToLower(strings.TrimSpace(w))] = true
	}
	out := []vocabTerm{} // [] rather than null when nothing is left
	for _, it := range items {
		term := strings.TrimSpace(it.Term)
		key := strings.ToLower(term)
		if term == "" || utf8.RuneCountInString(term) > 50 || seen[key] {
			continue
		}
		seen[key] = true
		var mis []string
		for _, m := range it.Misheard {
			if m = strings.TrimSpace(m); m != "" && m != term {
				mis = append(mis, m)
			}
		}
		out = append(out, vocabTerm{Term: term, Misheard: mis, Kind: it.Kind})
		if len(out) == vocabMaxTerms {
			break
		}
	}
	return out
}
