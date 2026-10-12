package main

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
)

type Template struct{ ID, Name, Prompt string }
type Language struct{ ID, Name string }

var languages = []Language{{"zh-TW", "繁體中文（台灣）"}, {"en", "English"}, {"ja", "日本語"}}

var templates = []Template{{"meeting", "會議摘要", `你是專業的會議記錄整理者。以下是一段錄音的逐字稿，格式為「[分:秒] 說話者: 內容」。逐字稿由語音辨識產生，可能有錯字或同音字，請依上下文理解。

請用{language}撰寫會議摘要，以 Markdown 輸出，包含以下段落（段落標題也使用{language}）：

## 概要
2–4 句說明這段錄音的主題、目的與結論。

## 重點
條列主要討論內容，每點一句，依討論順序排列。

## 決議
只列出明確達成共識的決定。「提議」與「決議」要分清楚：只是有人提出、尚未確認的，不要放在這裡。沒有就寫「無」。

## 待辦事項
格式：- [ ] 事項 — 負責人（期限）。負責人或期限不明時寫「未指定」。沒有就寫「無」。

## 未決問題
尚未解決、需要後續追蹤的問題。沒有就寫「無」。

規則：
- 只根據逐字稿內容，不要捏造人名、數字、日期或結論。
- 說話者名稱照逐字稿使用（例如 Speaker 1）。
- 專有名詞與英文術語保留原文。
- 直接輸出 Markdown 內容，不要加開場白或結語，不要用 ` + "```" + ` 包起來。

逐字稿：
{transcript}`}}

const cleanupPrompt = `你是語音辨識逐字稿的校對員。下面每一行是一個片段，格式為「編號<TAB>文字」。

請逐行校對「待校對」區的每一行：
- 補上正確的全形標點符號（，。？！、：「」），修正明顯的斷句。
- 修正明顯的語音辨識錯誤（同音字、錯詞、專有名詞），但只在上下文足以確定時才改；有多種可能時保留原文。
- 一律轉為繁體中文，使用台灣用語（例如：影片、軟體、資訊、品質）。
- 英文單字與專有名詞保持原樣，中英文之間不加多餘空格。
- 只刪除同一行內明顯的口吃重複（例如「我我我們」），其他口語內容保留。
- 這是校對，不是改寫：不要摘要、潤飾、補完句子、增加內容或加註解。
- 絕對不要合併或拆分行，也不要把一行的內容移到另一行。

{vocab}「上下文」區只供參考，不要輸出。

輸出規則：只輸出「待校對」區的每一行，每行格式為「編號<TAB>校對後文字」，編號必須與輸入完全相同，行數與輸入相同。不要輸出其他任何文字，不要用 ` + "```" + ` 包起來。

上下文（前）：
{before}

待校對：
{lines}

上下文（後）：
{after}`

const titlePrompt = `根據以下錄音逐字稿，為這段錄音取一個簡短的繁體中文標題（台灣用語）。
- 描述實際討論的主題，不超過 20 個字。
- 不要加「會議摘要」「錄音」「標題：」之類的前綴，不要加引號或標點結尾。
- 只輸出標題本身，不要其他文字。

逐字稿：
{transcript}`

const (
	sentenceEnd  = "。！？!?"
	cleanupBatch = 60
)

var (
	fenceRe     = regexp.MustCompile("(?s)^```\\w*\\s*(.*?)\\s*```$")
	cleanLineRe = regexp.MustCompile(`^\s*(\d+)[\t ]+(.*\S)`)
	titlePfxRe  = regexp.MustCompile(`^(標題|Title)\s*[:：]\s*`)
)

// processRecording runs one claimed recording job: download → ffmpeg → STT → diarize → publish.
func processRecording(ctx context.Context, cfg Config, t *task) error {
	dir := filepath.Join(cfg.DataDir, "work", strconv.FormatInt(t.ID, 10))
	os.RemoveAll(dir) // leftovers from a crashed run
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	defer os.RemoveAll(dir)

	src := filepath.Join(dir, "source"+strings.ToLower(filepath.Ext(t.Filename)))
	t0 := time.Now()
	if err := t.c.download(ctx, t.path("source"), src); err != nil {
		return fmt.Errorf("download source: %w", err)
	}
	if err := t.setStatus(ctx, "converting"); err != nil {
		return err
	}
	t1 := time.Now()
	wav, play := filepath.Join(dir, "audio.wav"), filepath.Join(dir, "play.m4a")
	out, err := exec.CommandContext(ctx, tool("ffmpeg"), "-nostdin", "-y", "-v", "error", "-i", src,
		"-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-bitexact", wav,
		"-vn", "-ac", "1", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", play,
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg: %w: %s", err, tail(out))
	}
	os.Remove(src) // free disk before STT
	fi, err := os.Stat(wav)
	if err != nil {
		return err
	}
	duration := float64(fi.Size()-44) / 32000 // 16 kHz mono s16 after the 44-byte header

	if err := t.setStatus(ctx, "transcribing"); err != nil {
		return err
	}
	t2 := time.Now()
	segs, err := transcribe(ctx, cfg, wav, t.Language, t.Settings.Vocab)
	if err != nil {
		return fmt.Errorf("transcribe: %w", err)
	}
	segs = splitSentences(segs)
	t3 := time.Now()
	turns, err := diarize(ctx, cfg, wav)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		slog.Error("diarize failed, using a single speaker", "recording", t.ID, "err", err)
		turns = nil
	}
	spk := splitCollapsed(cfg, wav, segs, assignSpeakers(segs, turns))
	embs, err := speakerEmbeddings(ctx, cfg, wav, segs, spk)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		slog.Error("speaker embeddings failed", "recording", t.ID, "err", err)
	}
	t4 := time.Now()
	if err := publish(ctx, cfg, t, duration, segs, spk, embs, play); err != nil {
		return err
	}
	slog.Info("processed", "recording", t.ID, "download", t1.Sub(t0).Round(time.Millisecond), "convert", t2.Sub(t1).Round(time.Millisecond),
		"stt", t3.Sub(t2).Round(time.Millisecond), "diarize", t4.Sub(t3).Round(time.Millisecond), "publish", time.Since(t4).Round(time.Millisecond))
	return nil
}

func tail(b []byte) string {
	return string(b[max(0, len(b)-1000):])
}

// publish uploads the transcript and play.m4a, cleans it up and titles it via ACP, and marks the job done.
func publish(ctx context.Context, cfg Config, t *task, duration float64, segs []Segment, spk []int, embs map[int][]float32, play string) error {
	type speaker struct {
		Label       string    `json:"label"`
		DisplayName string    `json:"display_name"`
		Embedding   []float32 `json:"embedding,omitempty"`
		EmbModel    string    `json:"emb_model,omitempty"`
	}
	type segment struct {
		StartMS int64  `json:"start_ms"`
		EndMS   int64  `json:"end_ms"`
		Speaker int    `json:"speaker"`
		TextRaw string `json:"text_raw"`
	}
	var speakers []speaker
	index := map[int]int{} // diarization speaker → index into speakers, by first appearance
	out := make([]segment, len(segs))
	for i, s := range segs {
		k, ok := index[spk[i]]
		if !ok {
			k = len(speakers)
			index[spk[i]] = k
			sp := speaker{Label: fmt.Sprintf("SPEAKER_%02d", spk[i]), DisplayName: fmt.Sprintf("Speaker %d", k+1), Embedding: embs[spk[i]]}
			if sp.Embedding != nil {
				sp.EmbModel = voiceModelID
			}
			speakers = append(speakers, sp)
		}
		out[i] = segment{int64(s.Start * 1000), int64(s.End * 1000), k, s.Text}
	}
	var res struct {
		SegmentIDs []int64 `json:"segment_ids"`
	}
	if err := t.post(ctx, "transcript", map[string]any{"duration_s": duration, "speakers": speakers, "segments": out}, &res); err != nil {
		return fmt.Errorf("transcript: %w", err)
	}
	if len(res.SegmentIDs) != len(segs) {
		return fmt.Errorf("transcript: got %d segment ids for %d segments", len(res.SegmentIDs), len(segs))
	}
	// audio right after the transcript, so it can be played while cleanup and title still run
	if err := uploadPlay(ctx, t, play); err != nil {
		return fmt.Errorf("upload play.m4a: %w", err)
	}

	rows := make([]segRow, len(segs))
	for i, s := range segs {
		rows[i] = segRow{res.SegmentIDs[i], s.Text}
	}
	if c := t.Settings.Cleanup; c == nil || *c {
		if err := t.setStatus(ctx, "cleaning"); err != nil {
			return err
		}
		if err := cleanup(ctx, cfg, t, rows); err != nil {
			if ctx.Err() != nil || errors.Is(err, errLeaseLost) {
				return err
			}
			slog.Error("cleanup failed", "recording", t.ID, "err", err)
		}
	}
	var text strings.Builder
	for _, r := range rows {
		text.WriteString(r.text + "\n")
	}
	if title, usage, err := makeTitle(ctx, cfg, t, text.String()); err != nil {
		slog.Error("title failed", "recording", t.ID, "err", err)
	} else if title != "" {
		if usage != nil {
			t.recordUsage(ctx, StepTitle, usage)
		}
		if err := t.post(ctx, "clean", map[string]any{"items": []any{}, "title": title}, nil); err != nil {
			return fmt.Errorf("title: %w", err)
		}
	}

	return t.post(ctx, "done", map[string]any{}, nil)
}

var playSinglePutMax int64 = 90 << 20 // above this play.m4a goes up as R2 multipart (SPEC)

func uploadPlay(ctx context.Context, t *task, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	q := url.Values{"runner": {t.c.runner}}.Encode() // the Worker checks the lease holder; a PUT body is raw audio
	if fi.Size() <= playSinglePutMax {
		data, err := io.ReadAll(f)
		if err != nil {
			return err
		}
		return t.c.put(ctx, t.path("play")+"?"+q, data, nil)
	}
	if err := t.post(ctx, "play/start?"+q, map[string]any{}, nil); err != nil {
		return err
	}
	parts, err := t.c.uploadParts(ctx, f, func(n int) string { return fmt.Sprintf("%s?part=%d&%s", t.path("play"), n, q) })
	if err != nil {
		return err
	}
	return t.post(ctx, "play/complete?"+q, map[string]any{"parts": parts}, nil)
}

// splitSentences cuts segments after each 。！？!? (plus trailing 」 etc.), timing pieces proportionally by rune position.
func splitSentences(segs []Segment) []Segment {
	var out []Segment
	for _, s := range segs {
		r := []rune(s.Text)
		at := func(i int) float64 { return s.Start + (s.End-s.Start)*float64(i)/float64(len(r)) }
		emit := func(a, b int) {
			if piece := strings.TrimSpace(string(r[a:b])); piece != "" {
				out = append(out, Segment{Start: at(a), End: at(b), Text: piece})
			}
		}
		cut, pending := 0, false
		for i, c := range r {
			isEnd := strings.ContainsRune(sentenceEnd, c)
			if pending && !isEnd && !unicode.In(c, unicode.Pe, unicode.Pf) {
				emit(cut, i)
				cut, pending = i, false
			}
			pending = pending || isEnd
		}
		emit(cut, len(r))
	}
	return out
}

func stripFence(s string) string {
	s = strings.TrimSpace(s)
	if m := fenceRe.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return s
}

// parseCleanup maps "<id>\t<text>" reply lines to text, keeping only ids in want.
func parseCleanup(reply string, want map[int64]bool) map[int64]string {
	fixed := map[int64]string{}
	for line := range strings.SplitSeq(stripFence(reply), "\n") {
		m := cleanLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		if id, err := strconv.ParseInt(m[1], 10, 64); err == nil && want[id] {
			fixed[id] = strings.TrimSpace(m[2])
		}
	}
	return fixed
}

type segRow struct {
	id   int64
	text string
}

// cleanup proofreads rows via LLM in batches, posting each batch and updating rows[i].text in place.
// A failed batch is logged and skipped.
func cleanup(ctx context.Context, cfg Config, t *task, rows []segRow) error {
	format := func(rs []segRow) string {
		var b strings.Builder
		for _, r := range rs {
			fmt.Fprintf(&b, "%d\t%s\n", r.id, r.text)
		}
		return cmp.Or(strings.TrimSuffix(b.String(), "\n"), "（無）")
	}
	for i := 0; i < len(rows); i += cleanupBatch {
		batch := rows[i:min(i+cleanupBatch, len(rows))]
		slog.Info("cleanup", "recording", t.ID, "batch", i/cleanupBatch+1, "of", (len(rows)+cleanupBatch-1)/cleanupBatch)
		prompt := buildCleanupPrompt(t.Settings.Vocab, format(rows[max(0, i-3):i]), format(batch),
			format(rows[min(i+cleanupBatch, len(rows)):min(i+cleanupBatch+3, len(rows))]))
		reply, usage, err := llmAsk(ctx, cfg, StepCleanup, prompt, t.Settings.Plan)
		if err != nil {
			if ctx.Err() != nil {
				return err
			}
			slog.Error("cleanup batch failed", "recording", t.ID, "batch", i/cleanupBatch, "err", err)
			continue
		}
		if usage != nil {
			t.recordUsage(ctx, StepCleanup, usage)
		}
		want := map[int64]bool{}
		for _, r := range batch {
			want[r.id] = true
		}
		fixed := parseCleanup(reply, want)
		items := []map[string]any{}
		for k := range batch {
			if s, ok := fixed[batch[k].id]; ok {
				batch[k].text = s
				items = append(items, map[string]any{"id": batch[k].id, "text_clean": s})
			}
		}
		if len(items) > 0 {
			if err := t.post(ctx, "clean", map[string]any{"items": items}, nil); err != nil {
				return err
			}
		}
	}
	return nil
}

// buildCleanupPrompt fills cleanupPrompt; the vocabulary line is there only when vocab is non-empty.
func buildCleanupPrompt(vocab []string, before, lines, after string) string {
	v := ""
	if len(vocab) > 0 {
		v = "專有名詞表（只在讀音或字形明顯相近時才改成這些詞，不要硬套）：" + strings.Join(vocab, "、") + "\n\n"
	}
	return strings.NewReplacer("{vocab}", v, "{before}", before, "{lines}", lines, "{after}", after).Replace(cleanupPrompt)
}

// makeTitle asks LLM for a short zh-TW title; "" when the transcript is too short to title.
func makeTitle(ctx context.Context, cfg Config, t *task, text string) (string, *LLMUsage, error) {
	r := []rune(strings.TrimSpace(text))
	if len(r) < 20 { // whisper hallucinates on silence; don't title noise
		return "", nil, nil
	}
	reply, usage, err := llmAsk(ctx, cfg, StepTitle, strings.Replace(titlePrompt, "{transcript}", string(r[:min(len(r), 3000)]), 1), t.Settings.Plan)
	if err != nil {
		return "", nil, err
	}
	first, _, _ := strings.Cut(stripFence(reply), "\n")
	nt := strings.TrimSpace(strings.Trim(titlePfxRe.ReplaceAllString(first, ""), " #*`\"'「」『』《》"))
	return string([]rune(nt)[:min(len([]rune(nt)), 30)]), usage, nil // prompt asks for ≤20; English words count per letter here
}

// summarize fills the template with the Worker-built transcript ("[mm:ss] Name: text" lines) and asks LLM.
func summarize(ctx context.Context, cfg Config, templateID, lang, transcript string, s jobSettings) (string, *LLMUsage, error) {
	prompt, err := summaryPrompt(templateID, lang, transcript, s)
	if err != nil {
		return "", nil, err
	}
	reply, usage, err := llmAsk(ctx, cfg, StepSummary, prompt, s.Plan)
	if err != nil {
		return "", nil, err
	}
	return stripFence(reply), usage, nil
}

// summaryPrompt fills the template and puts the user's preferences (non-empty parts only) before 逐字稿：.
func summaryPrompt(templateID, lang, transcript string, s jobSettings) (string, error) {
	i := slices.IndexFunc(templates, func(t Template) bool { return t.ID == templateID })
	if i < 0 {
		return "", fmt.Errorf("unknown template %q", templateID)
	}
	langName := lang
	if j := slices.IndexFunc(languages, func(l Language) bool { return l.ID == lang }); j >= 0 {
		langName = languages[j].Name
	}
	var prefs []string
	add := func(format, v string) {
		if v = strings.TrimSpace(v); v != "" {
			prefs = append(prefs, fmt.Sprintf(format, v))
		}
	}
	add("- 關於使用者：%s", s.About)
	add("- 內容重點：%s", s.ContentFocus)
	add("- 格式與語氣：%s", s.Instructions)
	add("- 錄音中的「%s」就是使用者本人；待辦事項中屬於使用者的請標註「（我）」。", s.Me)
	add("- 專有名詞：%s", strings.Join(s.Vocab, "、"))
	tmpl := templates[i].Prompt
	if len(prefs) > 0 {
		block := "使用者偏好（只調整語氣、重點與詳略，不要改變上面規定的段落結構）：\n" + strings.Join(prefs, "\n") + "\n\n"
		tmpl = strings.Replace(tmpl, "逐字稿：\n{transcript}", block+"逐字稿：\n{transcript}", 1)
	}
	return strings.NewReplacer("{language}", langName, "{transcript}", strings.TrimSpace(transcript)).Replace(tmpl), nil
}

// tool resolves a Homebrew binary; launchd's PATH may lack /opt/homebrew/bin.
func tool(name string) string {
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	return "/opt/homebrew/bin/" + name
}
