package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// backfillVoiceprints re-embeds, with the voice model, the speakers of done recordings that lack a voice-model
// embedding, or every speaker if recompute (SPEC Speaker ID v2). One failed recording is logged and skipped.
func backfillVoiceprints(ctx context.Context, cfg Config, recompute bool) error {
	if _, err := os.Stat(voiceModelPath(cfg)); err != nil {
		return errors.New("voice model missing; run `yanroku models`")
	}
	c := newClient(cfg)
	var recs []struct {
		ID       int64  `json:"id"`
		Status   string `json:"status"`
		Filename string `json:"filename"`
	}
	if err := c.json(ctx, "GET", "/api/recordings?trash=0&q=", nil, &recs); err != nil {
		return fmt.Errorf("list recordings: %w", err)
	}
	var done, failed int
	for _, r := range recs {
		if r.Status != "done" {
			continue
		}
		n, err := backfillRecording(ctx, cfg, c, r.ID, r.Filename, recompute)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			slog.Error("voiceprints", "recording", r.ID, "err", err)
			failed++
		} else if n > 0 {
			slog.Info("voiceprints", "recording", r.ID, "speakers", n)
			done++
		}
	}
	fmt.Printf("%d recording(s) updated, %d failed\n", done, failed)
	return nil
}

// backfillRecording returns how many speaker embeddings it posted (0 = nothing to do).
func backfillRecording(ctx context.Context, cfg Config, c *client, id int64, filename string, recompute bool) (int, error) {
	var d struct {
		Speakers []struct {
			ID       int64  `json:"id"`
			EmbModel string `json:"emb_model"` // null when no embedding
			Label    string `json:"label"`
		} `json:"speakers"`
		Segments []struct {
			StartMS   int64  `json:"start_ms"`
			EndMS     int64  `json:"end_ms"`
			SpeakerID *int64 `json:"speaker_id"`
		} `json:"segments"`
	}
	if err := c.json(ctx, "GET", fmt.Sprintf("/api/recordings/%d", id), nil, &d); err != nil {
		return 0, err
	}
	want := map[int64]bool{}
	for _, s := range d.Speakers {
		if (recompute || s.EmbModel != voiceModelID) && s.Label != "custom" { // custom = segment-scope speaker, never enrolled
			want[s.ID] = true
		}
	}
	var segs []Segment
	var spk []int64
	for _, s := range d.Segments {
		// shorter segments yield no embedding (see voiceSpans), so skip them and avoid a pointless download
		if s.SpeakerID != nil && want[*s.SpeakerID] && s.EndMS-s.StartMS >= 1750 {
			segs = append(segs, Segment{Start: float64(s.StartMS) / 1000, End: float64(s.EndMS) / 1000})
			spk = append(spk, *s.SpeakerID)
		}
	}
	if len(segs) == 0 {
		return 0, nil
	}

	dir := filepath.Join(cfg.DataDir, "work", fmt.Sprintf("vp-%d", id))
	os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return 0, err
	}
	defer os.RemoveAll(dir)
	src, wav := filepath.Join(dir, "source"+strings.ToLower(filepath.Ext(filename))), filepath.Join(dir, "audio.wav")
	if err := c.download(ctx, fmt.Sprintf("/api/runner/recordings/%d/source", id), src); err != nil {
		return 0, fmt.Errorf("download source: %w", err)
	}
	// ffmpeg probes the content, so a play.m4a saved under the original extension still decodes
	if out, err := exec.CommandContext(ctx, tool("ffmpeg"), "-nostdin", "-y", "-v", "error", "-i", src,
		"-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav).CombinedOutput(); err != nil {
		return 0, fmt.Errorf("ffmpeg: %w: %s", err, tail(out))
	}
	embs, err := speakerEmbeddings(ctx, cfg, wav, segs, spk)
	if err != nil || len(embs) == 0 {
		return 0, err
	}
	type item struct {
		ID        int64     `json:"id"`
		Embedding []float32 `json:"embedding"`
		EmbModel  string    `json:"emb_model"`
	}
	var items []item
	for sid, e := range embs {
		items = append(items, item{sid, e, voiceModelID})
	}
	return len(items), c.json(ctx, "POST", fmt.Sprintf("/api/runner/recordings/%d/speaker-embeddings", id),
		map[string]any{"runner": c.runner, "speakers": items}, nil)
}
