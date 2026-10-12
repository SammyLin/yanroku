package main

import (
	"bytes"
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Segment is one transcribed span; times in seconds.
type Segment struct {
	Start, End float64
	Text       string
}

// zhPrompt is example text, not an instruction: whisper echoes the prompt verbatim over silence/music,
// and an instruction ("請使用標點符號") then shows up as a subtitle. dropPromptEcho removes such echoes.
const zhPrompt = "好，那我們開始今天的會議。這一季的 roadmap 跟 API 進度，大家有什麼想法？"

// transcribe runs STT in lang (zh|en|ja|auto; "" = WHISPER_LANG) with vocab hinted in the prompt.
func transcribe(ctx context.Context, cfg Config, wavPath, lang string, vocab []string) ([]Segment, error) {
	cfg.WhisperLang = cmp.Or(lang, cfg.WhisperLang)
	prompt := sttPrompt(cfg.WhisperLang, vocab)
	var segs []Segment
	var err error
	if cfg.STTProvider == "groq" {
		segs, err = transcribeGroq(ctx, cfg, wavPath, prompt)
	} else {
		segs, err = transcribeLocal(ctx, cfg, wavPath, prompt)
	}
	return dropPromptEcho(segs, prompt, vocab), err
}

// dropPromptEcho removes segments whose text is just (part of) the prompt. A segment that is one vocab term
// (someone saying "Delta。") is real speech, not an echo, and is kept.
func dropPromptEcho(segs []Segment, prompt string, vocab []string) []Segment {
	p := bare(prompt)
	if p == "" {
		return segs
	}
	return slices.DeleteFunc(segs, func(s Segment) bool {
		t := bare(s.Text)
		if utf8.RuneCountInString(t) < 4 || !strings.Contains(p, t) {
			return false
		}
		return !slices.ContainsFunc(vocab, func(w string) bool { return strings.Contains(bare(w), t) })
	})
}

// bare keeps letters and digits only, lowercased.
func bare(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return unicode.ToLower(r)
		}
		return -1
	}, s)
}

// sttPromptMaxTokens stays under whisper's ~224-token prompt window.
const sttPromptMaxTokens = 200

// sttPrompt is the zh example sentence (zh only) followed by vocab joined by 、, in list order while it fits.
func sttPrompt(lang string, vocab []string) string {
	p := ""
	if lang == "zh" {
		p = zhPrompt
	}
	sep := ""
	for _, w := range vocab {
		if promptTokens(p+sep+w) > sttPromptMaxTokens {
			break
		}
		p += sep + w
		sep = "、"
	}
	return p
}

// promptTokens is a conservative token estimate: 1 per non-ASCII rune (CJK), 1 per started 4 ASCII chars.
// The settings UI uses the same estimate for「前 N 個詞會送進語音辨識」.
func promptTokens(s string) int {
	ascii, other := 0, 0
	for _, r := range s {
		if r < utf8.RuneSelf {
			ascii++
		} else {
			other++
		}
	}
	return other + (ascii+3)/4
}

// transcribeLocal runs whisper-cli with token-level JSON and DTW token timestamps, then cuts at sentence ends.
// Segment-level timestamps drift by up to ~15 s after long silence; DTW token times don't.
// VAD is not used: whisper-cli does not map token times back through it and merges sentences across the gaps.
func transcribeLocal(ctx context.Context, cfg Config, wavPath, prompt string) ([]Segment, error) {
	dir, err := os.MkdirTemp(filepath.Dir(wavPath), "whisper") // inside work/<id>, so crashed runs get cleaned up
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	out := filepath.Join(dir, "out")
	args := []string{"-m", cfg.WhisperModel, "-f", wavPath, "-l", cfg.WhisperLang, "-np",
		"-t", strconv.Itoa(min(runtime.NumCPU(), 8)), "-ojf", "-of", out}
	if prompt != "" {
		// carrying the prompt into every window keeps output Traditional and cut repetition loops in testing
		args = append(args, "--prompt", prompt, "--carry-initial-prompt")
	}
	if preset := dtwPreset(cfg.WhisperModel); preset != "" {
		args = append(args, "-dtw", preset, "-nfa") // DTW needs flash attention off
	}
	cmd := exec.CommandContext(ctx, tool("whisper-cli"), args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("whisper-cli: %w: %s", err, tail(stderr.Bytes()))
	}
	data, err := os.ReadFile(out + ".json")
	if err != nil {
		return nil, err
	}
	return parseWhisperJSON(data)
}

// dtwPreset maps ggml-large-v3-turbo[-q5_0].bin to whisper-cli's "large.v3.turbo"; "" if unknown.
func dtwPreset(model string) string {
	name := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(model), "ggml-"), ".bin")
	name, _, _ = strings.Cut(name, "-q")
	name = strings.ReplaceAll(name, "-", ".")
	if slices.Contains([]string{"tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en",
		"large.v1", "large.v2", "large.v3", "large.v3.turbo"}, name) {
		return name
	}
	return ""
}

const dtwLead = 0.2 // seconds

// parseWhisperJSON reads whisper-cli -ojf output and returns one segment per sentence.
func parseWhisperJSON(data []byte) ([]Segment, error) {
	var r struct {
		Transcription []struct {
			Offsets struct{ From, To int }
			Tokens  []struct {
				Text    string
				Offsets struct{ From, To int }
				TDTW    int `json:"t_dtw"`
			}
		}
	}
	if err := json.Unmarshal(protectInvalid(data), &r); err != nil {
		return nil, fmt.Errorf("whisper json: %w", err)
	}
	var segs []Segment
	for _, s := range r.Transcription {
		var text strings.Builder
		start, first := -1.0, true
		emit := func(end float64) {
			t := strings.TrimSpace(strings.ToValidUTF8(restoreInvalid(text.String()), "")) // drop bytes of runes never completed
			// whisper sometimes ends a window mid-sentence ("新的報告。" + next window "表功能。");
			// a short opening fragment overlapping the previous sentence is its continuation
			if n := len(segs); first && t != "" && n > 0 && start < segs[n-1].End && utf8.RuneCountInString(t) <= 4 {
				segs[n-1].Text = strings.TrimRight(segs[n-1].Text, sentenceEnd) + t
				segs[n-1].End = max(segs[n-1].End, end)
			} else if t != "" {
				segs = append(segs, Segment{start, max(end, start+0.01), t})
			}
			text.Reset()
			start, first = -1, false
		}
		for _, tok := range s.Tokens {
			// special tokens ([_BEG_], [_TT_123], [_EOT_]); whisper can glue one to a stray byte ("\xef[_EOT_]")
			if i := strings.Index(tok.Text, "[_"); i >= 0 {
				if tok.Text = tok.Text[:i]; tok.Text == "" {
					continue
				}
			}
			from, to := float64(tok.Offsets.From)/1000, float64(tok.Offsets.To)/1000
			if tok.TDTW >= 0 { // centiseconds; measured ~0.1-0.45 s late on sentence starts, so lead a little
				from, to = max(float64(tok.TDTW)/100-dtwLead, 0), float64(tok.TDTW)/100
			}
			if start < 0 {
				start = from
			}
			text.WriteString(tok.Text)
			if strings.ContainsAny(tok.Text, sentenceEnd) {
				emit(to)
			}
		}
		if text.Len() > 0 {
			emit(float64(s.Offsets.To) / 1000)
		}
	}
	return segs, nil
}

// whisper-cli writes each token's raw bytes, so a CJK rune split across tokens is invalid UTF-8 in the JSON.
// encoding/json would turn those bytes into U+FFFD; park them in U+F780..U+F7FF and restore after joining tokens.
func protectInvalid(b []byte) []byte {
	if utf8.Valid(b) {
		return b
	}
	out := make([]byte, 0, len(b)+16)
	for len(b) > 0 {
		r, n := utf8.DecodeRune(b)
		if r == utf8.RuneError && n == 1 {
			out = utf8.AppendRune(out, 0xF700+rune(b[0]))
		} else {
			out = append(out, b[:n]...)
		}
		b = b[n:]
	}
	return out
}

func restoreInvalid(s string) string {
	out := make([]byte, 0, len(s))
	for _, r := range s {
		if r >= 0xF780 && r <= 0xF7FF {
			out = append(out, byte(r-0xF700))
		} else {
			out = utf8.AppendRune(out, r)
		}
	}
	return strings.ToValidUTF8(string(out), "")
}

var groqURL = "https://api.groq.com/openai/v1/audio/transcriptions"

// groqQuotaError: Groq asked us to wait longer than groqMaxWait (the free tier caps audio seconds per hour
// and per day). The runner puts the recording back in the queue until then instead of blocking.
type groqQuotaError struct{ wait time.Duration }

func (e groqQuotaError) Error() string {
	return fmt.Sprintf("groq quota exhausted, retry after %s", e.wait)
}

const groqMaxWait = time.Minute

const groqChunkSec = 600 // 10 min of 16k mono FLAC is well under Groq's 25 MB limit

// transcribeGroq sends the audio in groqChunkSec FLAC chunks. Each chunk is cut by its own ffmpeg call:
// the segment muxer leaves FLAC headers without (or with the whole file's) duration, Groq bills by that
// header, and a 65 min file then cost ~7500 s per attempt — over the 7200 s/hour free quota on every retry.
// Finished chunks are cached by content, so a quota pause resumes instead of re-sending (and re-billing) them.
func transcribeGroq(ctx context.Context, cfg Config, wavPath, prompt string) ([]Segment, error) {
	if cfg.GroqAPIKey == "" {
		return nil, errors.New("GROQ_API_KEY is not set")
	}
	fi, err := os.Stat(wavPath)
	if err != nil {
		return nil, err
	}
	total := float64(fi.Size()-44) / 32000 // 16 kHz mono s16 after the 44-byte header
	dir, err := os.MkdirTemp(filepath.Dir(wavPath), "groq")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	cacheDir := filepath.Join(cfg.DataDir, "groq-cache")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return nil, err
	}
	pruneGroqCache(cfg)
	var segs []Segment
	var cached []string
	for i := 0; float64(i*groqChunkSec) < total; i++ {
		offset := float64(i * groqChunkSec)
		chunk := filepath.Join(dir, fmt.Sprintf("%04d.flac", i))
		cmd := exec.CommandContext(ctx, tool("ffmpeg"), "-nostdin", "-loglevel", "error", "-ss", strconv.Itoa(i*groqChunkSec),
			"-t", strconv.Itoa(groqChunkSec), "-i", wavPath, "-ar", "16000", "-ac", "1", "-c:a", "flac", chunk)
		if out, err := cmd.CombinedOutput(); err != nil {
			return nil, fmt.Errorf("ffmpeg chunk %d: %w: %s", i, err, tail(out))
		}
		got, cache, err := groqChunkCached(ctx, cfg, chunk, cacheDir, prompt)
		if err != nil {
			return nil, fmt.Errorf("groq chunk %d/%d: %w", i+1, int(math.Ceil(total/groqChunkSec)), err)
		}
		cached = append(cached, cache)
		for _, s := range got {
			segs = append(segs, Segment{s.Start + offset, s.End + offset, s.Text})
		}
	}
	for _, c := range cached {
		os.Remove(c)
	}
	return segs, nil
}

// pruneGroqCache deletes groq-cache files older than GROQ_CACHE_MAX_AGE: a job that never succeeds would
// otherwise keep its transcribed chunks forever (the privacy policy promises at most 7 days).
func pruneGroqCache(cfg Config) {
	maxAge := cmp.Or(cfg.GroqCacheAge, 168*time.Hour) // a zero Config never wipes the cache
	dir := filepath.Join(cfg.DataDir, "groq-cache")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return // no cache yet
	}
	for _, e := range entries {
		fi, err := e.Info()
		if err != nil || fi.IsDir() || time.Since(fi.ModTime()) <= maxAge {
			continue
		}
		if err := os.Remove(filepath.Join(dir, e.Name())); err != nil {
			slog.Warn("prune groq cache", "file", e.Name(), "err", err)
		}
	}
}

// groqChunkCached returns the chunk's segments from DATA_DIR/groq-cache/<sha256>.json, or transcribes and caches them.
// The key covers language and prompt too, so a re-transcribe with other settings doesn't reuse a paused run's chunks.
func groqChunkCached(ctx context.Context, cfg Config, chunk, cacheDir, prompt string) ([]Segment, string, error) {
	b, err := os.ReadFile(chunk)
	if err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(fmt.Appendf(b, "\x00%s\x00%s", cfg.WhisperLang, prompt))
	cache := filepath.Join(cacheDir, hex.EncodeToString(sum[:])+".json")
	if data, err := os.ReadFile(cache); err == nil {
		var segs []Segment
		if json.Unmarshal(data, &segs) == nil {
			return segs, cache, nil
		}
	}
	segs, _, err := groqChunk(ctx, cfg, chunk, prompt)
	if err != nil {
		return nil, "", err
	}
	data, _ := json.Marshal(segs)
	return segs, cache, os.WriteFile(cache, data, 0o644)
}

type groqSegment struct {
	Start, End       float64
	Text             string
	AvgLogprob       float64 `json:"avg_logprob"`
	CompressionRatio float64 `json:"compression_ratio"`
	NoSpeechProb     float64 `json:"no_speech_prob"`
}

// hallucinated applies Whisper's own thresholds: silence the model is unsure about, or a repetition loop.
func (g groqSegment) hallucinated() bool {
	return (g.NoSpeechProb > 0.6 && g.AvgLogprob < -1) || g.CompressionRatio > 2.4
}

func groqChunk(ctx context.Context, cfg Config, path, prompt string) ([]Segment, float64, error) {
	audio, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, err
	}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", filepath.Base(path))
	fw.Write(audio)
	mw.WriteField("model", cfg.GroqModel)
	mw.WriteField("response_format", "verbose_json")
	mw.WriteField("timestamp_granularities[]", "segment")
	mw.WriteField("temperature", "0")
	if cfg.WhisperLang != "auto" {
		mw.WriteField("language", cfg.WhisperLang)
	}
	if prompt != "" {
		mw.WriteField("prompt", prompt)
	}
	mw.Close()

	const attempts = 6
	for i := range attempts {
		req, _ := http.NewRequestWithContext(ctx, "POST", groqURL, bytes.NewReader(body.Bytes()))
		req.Header.Set("Authorization", "Bearer "+cfg.GroqAPIKey)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		resp, err := http.DefaultClient.Do(req)
		var wait time.Duration
		if err == nil {
			data, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				var r struct {
					Duration float64
					Segments []groqSegment
				}
				if err := json.Unmarshal(data, &r); err != nil {
					return nil, 0, err
				}
				var segs []Segment
				for _, g := range r.Segments {
					if t := strings.TrimSpace(g.Text); t != "" && g.End > g.Start && !g.hallucinated() {
						segs = append(segs, Segment{g.Start, g.End, t})
					}
				}
				return segs, r.Duration, nil
			}
			err = fmt.Errorf("HTTP %d: %s", resp.StatusCode, tail(data))
			if resp.StatusCode != http.StatusTooManyRequests && resp.StatusCode < 500 {
				return nil, 0, err
			}
			if s, perr := strconv.ParseFloat(resp.Header.Get("Retry-After"), 64); perr == nil {
				wait = time.Duration(s * float64(time.Second))
			}
			if resp.StatusCode == http.StatusTooManyRequests && wait > groqMaxWait {
				return nil, 0, groqQuotaError{wait}
			}
		}
		if ctx.Err() != nil || i == attempts-1 {
			return nil, 0, err
		}
		wait = min(max(wait, time.Second<<i), 2*time.Minute)
		slog.Warn("groq retry", "err", err, "wait", wait)
		select {
		case <-ctx.Done():
			return nil, 0, ctx.Err()
		case <-time.After(wait):
		}
	}
	panic("unreachable")
}
