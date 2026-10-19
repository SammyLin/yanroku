package main

import (
	"cmp"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"syscall"

	sherpa "github.com/k2-fsa/sherpa-onnx-go-macos"
)

type Turn struct {
	Start, End float64
	Speaker    int
}

const (
	segModelURL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
	embModelURL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"
	// voiceModelURL makes voiceprints (SPEC Speaker ID v2): slower than campplus but keeps one person
	// apart from others across recordings. Diarization keeps campplus.
	voiceModelURL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_large_sv_zh-cn_3dspeaker_16k.onnx"
	voiceModelID  = "eres2net-large-zh-cn" // emb_model sent with every voiceprint embedding
)

func segModelPath(cfg Config) string {
	return filepath.Join(cfg.DataDir, "models", "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx")
}

func embModelPath(cfg Config) string {
	return filepath.Join(cfg.DataDir, "models", filepath.Base(embModelURL))
}

func voiceModelPath(cfg Config) string {
	return filepath.Join(cfg.DataDir, "models", filepath.Base(voiceModelURL))
}

// onnxThreads is the performance-core count. onnxruntime threads that spill onto efficiency cores stall its
// intra-op sync: on a 4P+6E M-series Mac, 10 threads made sherpa diarization 4x slower than 4 (measured 2026-10-05).
var onnxThreads = func() int {
	if n, err := syscall.SysctlUint32("hw.perflevel0.physicalcpu"); err == nil && n > 0 {
		return int(n)
	}
	return 4
}()

var warnNoModels = sync.OnceFunc(func() {
	slog.Warn("diarization models missing, using a single speaker; run `yanroku models`")
})

// diarize expects a 16 kHz mono wav (audio.wav from the pipeline).
func diarize(ctx context.Context, cfg Config, wavPath string) ([]Turn, error) {
	if !cfg.Diarize {
		return nil, nil
	}
	seg, emb := segModelPath(cfg), embModelPath(cfg)
	for _, p := range []string{seg, emb} {
		if _, err := os.Stat(p); err != nil {
			warnNoModels()
			return nil, nil
		}
	}
	c := sherpa.OfflineSpeakerDiarizationConfig{
		Segmentation: sherpa.OfflineSpeakerSegmentationModelConfig{
			Pyannote:   sherpa.OfflineSpeakerSegmentationPyannoteModelConfig{Model: seg},
			NumThreads: onnxThreads,
		},
		Embedding:      sherpa.SpeakerEmbeddingExtractorConfig{Model: emb, NumThreads: onnxThreads},
		Clustering:     sherpa.FastClusteringConfig{NumClusters: cfg.NumSpeakers, Threshold: 0.5},
		MinDurationOn:  0.3,
		MinDurationOff: 0.5,
	}
	if cfg.NumSpeakers <= 0 {
		c.Clustering.NumClusters = -1
	}
	sd := sherpa.NewOfflineSpeakerDiarization(&c)
	if sd == nil {
		return nil, errors.New("sherpa-onnx: cannot create speaker diarization")
	}
	defer sherpa.DeleteOfflineSpeakerDiarization(sd)

	w, err := openWav(wavPath)
	if err != nil {
		return nil, err
	}
	defer w.Close()
	if w.rate != sd.SampleRate() {
		return nil, fmt.Errorf("diarize: %s is %d Hz, want %d", wavPath, w.rate, sd.SampleRate())
	}
	chunk := diarizeChunkSec * w.rate
	var turns []Turn
	for ci, off := 0, 0; off < w.n; ci, off = ci+1, off+chunk {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if w.n-off-chunk < 60*w.rate { // fold a short tail into the last chunk
			chunk = w.n - off
		}
		x, err := w.read(off, chunk)
		if err != nil {
			return nil, err
		}
		t0 := float64(off) / float64(w.rate)
		for _, s := range sd.Process(x) { // chunk-local labels made global
			turns = append(turns, Turn{t0 + float64(s.Start), t0 + float64(s.End), ci<<16 + s.Speaker})
		}
	}

	ex := sherpa.NewSpeakerEmbeddingExtractor(&c.Embedding)
	if ex == nil {
		return nil, errors.New("sherpa-onnx: cannot create embedding extractor")
	}
	defer sherpa.DeleteSpeakerEmbeddingExtractor(ex)
	embs := make([][]float32, len(turns))
	for i, t := range turns {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		a, b := int(t.Start*float64(w.rate)), int(t.End*float64(w.rate))
		if b-a < w.rate {
			continue
		}
		x, err := w.read(a, b-a)
		if err != nil {
			return nil, err
		}
		if len(x) >= w.rate {
			embs[i] = embed(ex, w.rate, x)
		}
	}
	return mergeTurns(turns, embs), nil
}

// diarizeChunkSec bounds memory and time: sherpa clusters every ~1 s window of its input at once (O(n²)
// distance matrix, >100 GB for 24 h, and superlinear time). Longer files are diarized per chunk and
// mergeTurns links the chunks' speakers.
var diarizeChunkSec = 15 * 60

const (
	mergeSim  = 0.5 // clusters whose mean embeddings are more similar than this are one speaker
	minSpkSec = 30. // clusters with less speech fold into the most similar larger one
)

// mergeTurns fixes sherpa's over-segmentation (one person split into many clusters, within and across
// chunks). embs[i] is turns[i]'s embedding, nil for turns under 1 s. A cluster's mean is the
// duration-weighted sum of its normalized turn embeddings. The most similar pair is merged while its cosine
// exceeds mergeSim; then clusters under minSpkSec fold into their most similar cluster of at least
// minSpkSec (if any). Clusters without an embedded turn are dropped (their segments take the nearest turn).
// Labels are renumbered 0..n-1 by first appearance.
// ponytail: O(n³) cheap compares + O(n²·dim) cosines; ~1 s at 800 clusters (≈10 h of audio).
func mergeTurns(turns []Turn, embs [][]float32) []Turn {
	type cluster struct {
		sum []float32
		dur float64
	}
	cs := map[int]*cluster{}
	for i, t := range turns {
		c := cs[t.Speaker]
		if c == nil {
			c = &cluster{}
			cs[t.Speaker] = c
		}
		d := t.End - t.Start
		c.dur += d
		if embs[i] == nil {
			continue
		}
		if c.sum == nil {
			c.sum = make([]float32, len(embs[i]))
		}
		w := float32(d / max(norm(embs[i]), 1e-12))
		for k, v := range embs[i] {
			c.sum[k] += w * v
		}
	}
	parent := map[int]int{} // merged cluster → the cluster it went into
	find := func(l int) int {
		for {
			p, ok := parent[l]
			if !ok {
				return l
			}
			l = p
		}
	}
	merge := func(from, into int) {
		for k, v := range cs[from].sum {
			cs[into].sum[k] += v
		}
		cs[into].dur += cs[from].dur
		parent[from] = into
	}
	live := func() []int {
		var ls []int
		for l, c := range cs {
			if _, gone := parent[l]; !gone && c.sum != nil {
				ls = append(ls, l)
			}
		}
		slices.Sort(ls)
		return ls
	}
	// pairwise similarity matrix; a merge only recomputes the surviving cluster's row
	ids := live()
	sim := make([][]float64, len(ids))
	for i := range ids {
		sim[i] = make([]float64, len(ids))
		for j := range i {
			sim[i][j] = cosine(cs[ids[i]].sum, cs[ids[j]].sum)
			sim[j][i] = sim[i][j]
		}
	}
	dead := make([]bool, len(ids))
	for {
		a, b, best := -1, -1, mergeSim
		for i := range ids {
			for j := i + 1; j < len(ids); j++ {
				if !dead[i] && !dead[j] && sim[i][j] > best {
					a, b, best = i, j, sim[i][j]
				}
			}
		}
		if a < 0 {
			break
		}
		merge(ids[b], ids[a])
		dead[b] = true
		for j := range ids {
			if !dead[j] && j != a {
				sim[a][j] = cosine(cs[ids[a]].sum, cs[ids[j]].sum)
				sim[j][a] = sim[a][j]
			}
		}
	}
	ls := live()
	var big []int
	for _, l := range ls {
		if cs[l].dur >= minSpkSec {
			big = append(big, l)
		}
	}
	if len(big) > 0 {
		for _, l := range ls {
			if cs[l].dur >= minSpkSec {
				continue
			}
			into := slices.MaxFunc(big, func(x, y int) int {
				return cmp.Compare(cosine(cs[l].sum, cs[x].sum), cosine(cs[l].sum, cs[y].sum))
			})
			merge(l, into)
		}
	}
	var out []Turn
	for _, t := range turns {
		if t.Speaker = find(t.Speaker); cs[t.Speaker].sum != nil {
			out = append(out, t)
		}
	}
	slices.SortStableFunc(out, func(x, y Turn) int { return cmp.Compare(x.Start, y.Start) })
	label := map[int]int{}
	for i, t := range out {
		k, ok := label[t.Speaker]
		if !ok {
			k = len(label)
			label[t.Speaker] = k
		}
		out[i].Speaker = k
	}
	return out
}

func embed(ex *sherpa.SpeakerEmbeddingExtractor, rate int, x []float32) []float32 {
	st := ex.CreateStream()
	defer sherpa.DeleteOnlineStream(st)
	st.AcceptWaveform(rate, x)
	st.InputFinished()
	return ex.Compute(st)
}

// wavFile reads 16-bit mono PCM samples on demand; sherpa.ReadWave holds the whole file twice
// (C buffer + Go copy, ~11 GB for 24 h).
type wavFile struct {
	*os.File
	rate, n int   // sample rate, sample count
	data    int64 // offset of the first sample
}

func openWav(path string) (*wavFile, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	w := &wavFile{File: f}
	le := binary.LittleEndian
	var h [24]byte
	for off := int64(12); ; {
		if _, err := f.ReadAt(h[:8], off); err != nil {
			f.Close()
			return nil, fmt.Errorf("%s: no wav data chunk: %w", path, err)
		}
		size := int64(le.Uint32(h[4:8]))
		switch string(h[:4]) {
		case "fmt ":
			if _, err := f.ReadAt(h[8:24], off+8); err != nil {
				f.Close()
				return nil, fmt.Errorf("%s: %w", path, err)
			}
			if le.Uint16(h[8:]) != 1 || le.Uint16(h[10:]) != 1 || le.Uint16(h[22:]) != 16 {
				f.Close()
				return nil, fmt.Errorf("%s: want 16-bit mono PCM wav", path)
			}
			w.rate = int(le.Uint32(h[12:]))
		case "data":
			fi, err := f.Stat()
			if err != nil || w.rate == 0 {
				f.Close()
				return nil, fmt.Errorf("%s: bad wav header", path)
			}
			w.data = off + 8
			w.n = int(min(size, fi.Size()-w.data) / 2)
			return w, nil
		}
		off += 8 + size + size&1
	}
}

// read returns samples [from, from+n) scaled to [-1, 1), clipped to the file.
func (w *wavFile) read(from, n int) ([]float32, error) {
	from = max(from, 0)
	n = min(n, w.n-from)
	if n <= 0 {
		return nil, nil
	}
	b := make([]byte, 2*n)
	if k, err := w.ReadAt(b, w.data+2*int64(from)); k < len(b) {
		return nil, err
	}
	x := make([]float32, n)
	for i := range x {
		x[i] = float32(int16(binary.LittleEndian.Uint16(b[2*i:]))) / 32768
	}
	return x, nil
}

// assignSpeakers picks, per segment, the turn speaker with the most time overlap, else the nearest turn.
func assignSpeakers(segs []Segment, turns []Turn) []int {
	out := make([]int, len(segs))
	if len(turns) == 0 {
		return out
	}
	for i, s := range segs {
		overlap := map[int]float64{}
		best, bestOv := -1, 0.0
		near, nearDist := 0, math.Inf(1)
		for _, t := range turns {
			if ov := min(s.End, t.End) - max(s.Start, t.Start); ov > 0 {
				overlap[t.Speaker] += ov
				if overlap[t.Speaker] > bestOv {
					best, bestOv = t.Speaker, overlap[t.Speaker]
				}
			} else if d := max(t.Start-s.End, s.Start-t.End); d < nearDist {
				near, nearDist = t.Speaker, d
			}
		}
		if best < 0 {
			best = near
		}
		out[i] = best
	}
	return out
}

// splitCollapsed re-checks a single-speaker result with per-sentence embeddings. pyannote segmentation can
// merge similar voices (two female TTS voices in testing) that the embedding model still tells apart
// (sentence cosine ~0.9 within a voice vs ~0.6 across). Split only if the two halves are clearly apart.
// ponytail: only splits 1 -> 2 speakers; 3+ merged voices would need full agglomerative clustering.
func splitCollapsed(cfg Config, wavPath string, segs []Segment, spk []int) []int {
	if !cfg.Diarize || cfg.NumSpeakers == 1 || len(spk) == 0 || slices.ContainsFunc(spk, func(s int) bool { return s != spk[0] }) {
		return spk
	}
	if _, err := os.Stat(embModelPath(cfg)); err != nil {
		return spk
	}
	ex := sherpa.NewSpeakerEmbeddingExtractor(&sherpa.SpeakerEmbeddingExtractorConfig{Model: embModelPath(cfg), NumThreads: onnxThreads})
	if ex == nil {
		return spk
	}
	defer sherpa.DeleteSpeakerEmbeddingExtractor(ex)
	w, err := openWav(wavPath)
	if err != nil {
		return spk
	}
	defer w.Close()
	var idx []int
	var embs [][]float32
	for i, s := range segs {
		// trim edges: sentence starts are led by 0.2 s and ends run up to ~0.8 s late, into the next turn
		a, b := int((s.Start+0.25)*float64(w.rate)), min(int((s.End-0.5)*float64(w.rate)), w.n)
		if b-a < w.rate {
			continue
		}
		x, err := w.read(a, b-a)
		if err != nil {
			return spk
		}
		embs = append(embs, embed(ex, w.rate, x))
		idx = append(idx, i)
	}
	lab, gap := split2(embs)
	if gap < 0.2 {
		return spk
	}
	out := make([]int, len(segs))
	for i := range segs { // short segments take the label of the nearest embedded one
		near := 0
		for j := range idx {
			if abs(idx[j]-i) < abs(idx[near]-i) {
				near = j
			}
		}
		out[i] = lab[near]
	}
	return out
}

func abs(x int) int { return max(x, -x) }

func cosine(a, b []float32) float64 {
	var d, na, nb float64
	for k := range a {
		d += float64(a[k] * b[k])
		na += float64(a[k] * a[k])
		nb += float64(b[k] * b[k])
	}
	return d / math.Sqrt(na*nb)
}

// split2 runs 2-means on cosine similarity and returns the labels and mean within- minus between-cluster
// similarity (0 when there's nothing to split: fewer than 2 members on a side).
func split2(e [][]float32) ([]int, float64) {
	lab := make([]int, len(e))
	if len(e) < 4 {
		return lab, 0
	}
	far := 0
	for i := range e {
		if cosine(e[0], e[i]) < cosine(e[0], e[far]) {
			far = i
		}
	}
	c := [][]float32{e[0], e[far]}
	for range 10 {
		for i := range e {
			lab[i] = 0
			if cosine(e[i], c[1]) > cosine(e[i], c[0]) {
				lab[i] = 1
			}
		}
		c = [][]float32{make([]float32, len(e[0])), make([]float32, len(e[0]))}
		for i := range e {
			for k, v := range e[i] {
				c[lab[i]][k] += v
			}
		}
	}
	var within, between, nw, nb float64
	for i := range e {
		for j := i + 1; j < len(e); j++ {
			if lab[i] == lab[j] {
				within, nw = within+cosine(e[i], e[j]), nw+1
			} else {
				between, nb = between+cosine(e[i], e[j]), nb+1
			}
		}
	}
	n1 := 0
	for _, l := range lab {
		n1 += l
	}
	if n1 < 2 || len(e)-n1 < 2 {
		return lab, 0
	}
	return lab, within/nw - between/nb
}

const voiceprintSec = 600.0 // audio per speaker that goes into its voiceprint (bounds time on long files)

// speakerEmbeddings computes one L2-normalized voiceprint per speaker (spk[i] is segs[i]'s speaker) with the voice
// model: the mean of per-span embeddings over up to voiceprintSec of that speaker's longest clean spans, rounded
// to 4 decimals to keep the JSON small. Speakers without a span long enough get none; nil (no error) if the
// voice model is missing.
func speakerEmbeddings[K comparable](ctx context.Context, cfg Config, wavPath string, segs []Segment, spk []K) (map[K][]float32, error) {
	if _, err := os.Stat(voiceModelPath(cfg)); err != nil {
		slog.Warn("voice model missing, no speaker embeddings; run `yanroku models`")
		return nil, nil
	}
	ex := sherpa.NewSpeakerEmbeddingExtractor(&sherpa.SpeakerEmbeddingExtractorConfig{Model: voiceModelPath(cfg), NumThreads: onnxThreads})
	if ex == nil {
		return nil, errors.New("sherpa-onnx: cannot create embedding extractor")
	}
	defer sherpa.DeleteSpeakerEmbeddingExtractor(ex)
	w, err := openWav(wavPath)
	if err != nil {
		return nil, err
	}
	defer w.Close()
	bySpeaker := map[K][]Segment{}
	for i, s := range segs {
		bySpeaker[spk[i]] = append(bySpeaker[spk[i]], s)
	}
	out := map[K][]float32{}
	for k, ss := range bySpeaker {
		var embs [][]float32
		for _, s := range voiceSpans(ss, voiceprintSec) {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			a, b := int(s.Start*float64(w.rate)), int(s.End*float64(w.rate))
			x, err := w.read(a, b-a)
			if err != nil {
				return nil, err
			}
			if len(x) >= w.rate {
				embs = append(embs, embed(ex, w.rate, x))
			}
		}
		if len(embs) > 0 {
			m := meanNormalized(embs)
			for i, v := range m {
				m[i] = float32(math.Round(float64(v)*1e4) / 1e4)
			}
			out[k] = m
		}
	}
	return out, nil
}

// voiceSpans trims segment edges like splitCollapsed, keeps spans of at least 1 s and returns the longest
// first, totalling at most maxSec (the last one clipped).
func voiceSpans(segs []Segment, maxSec float64) []Segment {
	var sp []Segment
	for _, s := range segs {
		if a, b := s.Start+0.25, s.End-0.5; b-a >= 1 {
			sp = append(sp, Segment{Start: a, End: b})
		}
	}
	slices.SortStableFunc(sp, func(x, y Segment) int { return cmp.Compare(y.End-y.Start, x.End-x.Start) })
	var out []Segment
	left := maxSec
	for _, s := range sp {
		s.End = min(s.End, s.Start+left)
		if s.End-s.Start < 1 {
			break
		}
		out = append(out, s)
		left -= s.End - s.Start
	}
	return out
}

// meanNormalized L2-normalizes each embedding (so loud segments don't dominate), averages them and
// L2-normalizes the mean.
func meanNormalized(embs [][]float32) []float32 {
	m := make([]float32, len(embs[0]))
	for _, e := range embs {
		n := float32(max(norm(e), 1e-12))
		for i, v := range e {
			m[i] += v / n
		}
	}
	n := float32(max(norm(m), 1e-12))
	for i := range m {
		m[i] /= n
	}
	return m
}

func norm(e []float32) float64 {
	var n float64
	for _, v := range e {
		n += float64(v) * float64(v)
	}
	return math.Sqrt(n)
}
