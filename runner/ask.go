package main

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	askMaxPicks = 8
	// ponytail: char budget for step-2 transcripts; CJK is ~1 token per char, so this stays well inside a 200k-token context
	askBudget = 150_000
)

// askEntry is one recording in an ask job's index (POST /api/runner/claim, kind "ask").
type askEntry struct {
	ID        int64    `json:"id"`
	Title     string   `json:"title"`
	Date      string   `json:"date"`
	DurationS *float64 `json:"duration_s,omitempty"`
	Speakers  []string `json:"speakers"`
	Summary   *string  `json:"summary,omitempty"`
}

// askDoc is one transcript from GET /api/runner/asks/{id}/transcripts.
type askDoc struct {
	ID         int64  `json:"id"`
	Title      string `json:"title"`
	Date       string `json:"date"`
	Transcript string `json:"transcript"`
}

const askPickPrompt = `你是錄音資料庫的檢索助手。今天是 {today}。
下面是使用者所有錄音的索引，每行一筆 JSON：id、title（標題）、date（錄音日期）、duration_s（秒）、speakers（講者）、summary（摘要開頭，可能沒有）。

請挑出最可能含有回答所需資訊的錄音，最多 8 筆，依相關程度由高到低排序。
- 問題裡的日期條件（例如「上個月」「上週」「昨天」）要依今天換算後比對 date。
- 問題提到的人名要比對 speakers 與標題、摘要。
- 只輸出一個 JSON 陣列，內容是錄音 id，例如 [12, 5, 31]；不要輸出任何其他文字。沒有相關錄音就輸出 []。

問題：{question}

錄音索引：
{index}`

const askAnswerPrompt = `你要根據使用者的錄音逐字稿回答問題。今天是 {today}。
每份逐字稿的標題列是「## 錄音 <id>：<標題>（<日期>）」，每行格式為「[分:秒] 說話者: 內容」。逐字稿由語音辨識產生，可能有同音錯字，請依上下文理解。

規則：
- 只根據下面的逐字稿回答，不要編造或補充逐字稿以外的事。
- 每個陳述後面緊接著標註出處，格式固定為 [[錄音id@分:秒]]，時間取自那句話行首的時間，例如 [[12@03:45]]；一個陳述有多個出處就連續寫，例如 [[12@03:45]][[5@10:02]]。不要用其他引用格式，也不要另外列參考資料。
- 用提問的語言回答：中文問題用繁體中文、台灣用語；Answer in the language of the question — an English question gets an English answer, even though these instructions and the transcripts are in Chinese.
- 用 Markdown，先給結論，再條列細節；提到人時用逐字稿裡的說話者名稱。
- 逐字稿裡找不到答案就直接說找不到，不要猜。

問題：{question}

逐字稿：
{transcripts}`

// answer runs an ask job: pick relevant recordings from the index, fetch their transcripts, answer with citations.
func answer(ctx context.Context, cfg Config, t *task) error {
	valid := make(map[int64]bool, len(t.Index))
	var index strings.Builder
	for _, e := range t.Index {
		valid[e.ID] = true
		line, err := json.Marshal(e)
		if err != nil {
			return err
		}
		index.Write(line)
		index.WriteByte('\n')
	}
	var picked []int64
	if len(t.Index) > 0 {
		reply, usage, err := llmAsk(ctx, cfg, StepAsk, strings.NewReplacer("{today}", t.Today, "{question}", t.Question, "{index}", index.String()).Replace(askPickPrompt), t.Settings.Plan)
		if err != nil {
			return err
		}
		if usage != nil {
			t.recordUsage(ctx, StepAsk, usage)
		}
		picked = parsePicked(reply, valid, askMaxPicks)
	}
	slog.Info("ask: picked recordings", "ask", t.ID, "ids", picked)

	var docs []askDoc
	if len(picked) > 0 {
		ids := make([]string, len(picked))
		for i, id := range picked {
			ids[i] = strconv.FormatInt(id, 10)
		}
		q := url.Values{"ids": {strings.Join(ids, ",")}, "runner": {t.c.runner}}.Encode()
		if err := t.c.json(ctx, "GET", t.path("transcripts")+"?"+q, nil, &docs); err != nil {
			return err
		}
		var dropped []int64
		if docs, dropped = fitBudget(docs, askBudget); len(dropped) > 0 {
			slog.Warn("ask: transcripts over budget, dropped the least relevant", "ask", t.ID, "dropped", dropped, "budget_chars", askBudget)
		}
	}

	reply, usage, err := llmAsk(ctx, cfg, StepAsk, answerPrompt(t.Question, t.Today, docs), t.Settings.Plan)
	if err != nil {
		return err
	}
	if usage != nil {
		t.recordUsage(ctx, StepAsk, usage)
	}
	sources := make([]int64, 0, len(docs)) // [] rather than null when nothing was relevant
	for _, d := range docs {
		sources = append(sources, d.ID)
	}
	return t.post(ctx, "result", map[string]any{"answer_md": stripFence(reply), "sources": sources}, nil)
}

func answerPrompt(question, today string, docs []askDoc) string {
	var b strings.Builder
	for _, d := range docs {
		fmt.Fprintf(&b, "## 錄音 %d：%s（%s）\n%s\n\n", d.ID, d.Title, d.Date, strings.TrimSpace(d.Transcript))
	}
	tr := cmp.Or(strings.TrimSpace(b.String()), "（沒有找到相關的錄音）")
	return strings.NewReplacer("{today}", today, "{question}", question, "{transcripts}", tr).Replace(askAnswerPrompt)
}

// parsePicked reads the first JSON array in reply (fences and prose around it are fine) as recording ids:
// numbers, numeric strings or {"id": n} objects. Keeps ids in valid, in order, without duplicates, at most limit.
func parsePicked(reply string, valid map[int64]bool, limit int) []int64 {
	var items []any
	if !firstJSONArray(reply, &items) {
		return nil
	}
	var out []int64
	seen := map[int64]bool{}
	for _, it := range items {
		var id int64
		switch v := it.(type) {
		case float64:
			id = int64(v)
		case string:
			id, _ = strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		case map[string]any:
			if f, ok := v["id"].(float64); ok {
				id = int64(f)
			}
		}
		if valid[id] && !seen[id] {
			seen[id] = true
			out = append(out, id)
			if len(out) == limit {
				break
			}
		}
	}
	return out
}

// firstJSONArray decodes the first '[' in reply that starts a valid JSON value of v's type (a slice pointer).
func firstJSONArray(reply string, v any) bool {
	for rest := reply; ; rest = rest[1:] {
		i := strings.IndexByte(rest, '[')
		if i < 0 {
			return false
		}
		rest = rest[i:]
		if json.NewDecoder(strings.NewReader(rest)).Decode(v) == nil {
			return true
		}
	}
}

// fitBudget keeps transcripts (most relevant first) while their total length stays within budget chars and
// returns the ids it dropped. A first transcript that alone is over budget is cut to its first budget chars.
func fitBudget(docs []askDoc, budget int) (kept []askDoc, dropped []int64) {
	used := 0
	for _, d := range docs {
		n := utf8.RuneCountInString(d.Transcript)
		switch {
		case used+n <= budget:
			kept = append(kept, d)
			used += n
		case len(kept) == 0:
			d.Transcript = string([]rune(d.Transcript)[:budget])
			kept = append(kept, d)
			used = budget
		default:
			dropped = append(dropped, d.ID)
		}
	}
	return kept, dropped
}
