package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
)

var mediaExts = strings.Fields(`.mp3 .m4a .wav .aac .flac .ogg .opus .oga .wma .amr .aiff .aif
	.mp4 .m4v .mov .mkv .avi .webm .wmv .flv .mpg .mpeg .rmvb .rm .divx .ts .m2ts .3gp .f4v .asr`)

func main() {
	if err := loadDotEnv(".env"); err != nil {
		fatal(err)
	}
	cfg := loadConfig()
	if err := validateProfile(cfg, os.Getenv("RUNNER_PROFILE")); err != nil {
		fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	context.AfterFunc(ctx, stop) // second signal kills the process during a long shutdown

	args := os.Args[1:]
	cmd := "run"
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}
	if needsAPI(cmd) {
		base, err := validateAPIBase(cfg.APIBase)
		if err != nil {
			fatal(err)
		}
		cfg.APIBase = base
	}
	var err error
	switch {
	case cmd == "run" && len(args) == 0:
		err = run(ctx, cfg)
	case cmd == "ingest" && len(args) == 1:
		err = ingest(ctx, newClient(cfg), args[0])
	case cmd == "voiceprints" && len(args) == 0:
		err = backfillVoiceprints(ctx, cfg, false)
	case cmd == "voiceprints" && len(args) == 1 && args[0] == "--recompute":
		err = backfillVoiceprints(ctx, cfg, true)
	case cmd == "models" && len(args) == 0:
		err = downloadModels(ctx, cfg)
	case cmd == "version" && len(args) == 0:
		rev, at := buildVersion()
		fmt.Println(rev, at)
	default:
		err = errors.New("usage: tally [run] | tally ingest <folder> | tally voiceprints [--recompute] | tally models | tally version")
	}
	if err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "tally:", err)
	os.Exit(1)
}

// ingest uploads every media file under root not already present (same filename + size),
// mapping each file's subdirectory path to a folder path (created as needed; files in root stay unfiled).
func ingest(ctx context.Context, c *client, root string) error {
	type folderKey struct {
		parent int64 // 0 = top level
		name   string
	}
	var list []struct {
		ID       int64  `json:"id"`
		ParentID *int64 `json:"parent_id"`
		Name     string `json:"name"`
	}
	if err := c.json(ctx, "GET", "/api/folders", nil, &list); err != nil {
		return fmt.Errorf("list folders: %w", err)
	}
	folders := map[folderKey]int64{}
	for _, f := range list {
		var parent int64
		if f.ParentID != nil {
			parent = *f.ParentID
		}
		folders[folderKey{parent, f.Name}] = f.ID
	}
	folderFor := func(rel string) (*int64, error) {
		if rel == "." {
			return nil, nil
		}
		var parent int64
		for name := range strings.SplitSeq(filepath.ToSlash(rel), "/") {
			k := folderKey{parent, name}
			if id, ok := folders[k]; ok {
				parent = id
				continue
			}
			body := map[string]any{"name": name, "parent_id": nil}
			if parent != 0 {
				body["parent_id"] = parent
			}
			var f struct {
				ID int64 `json:"id"`
			}
			if err := c.json(ctx, "POST", "/api/folders", body, &f); err != nil {
				return nil, fmt.Errorf("create folder %s: %w", rel, err)
			}
			folders[k], parent = f.ID, f.ID
		}
		return &parent, nil
	}

	added := 0
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// hidden entries: AppleDouble "._x.m4a" files on exFAT/SMB drives, .Trashes, .Spotlight-V100, ...
		if path != root && strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() || !slices.Contains(mediaExts, strings.ToLower(filepath.Ext(path))) {
			return nil
		}
		fi, err := d.Info()
		if err != nil || fi.Size() == 0 {
			return err
		}
		var existing []struct {
			ID     int64  `json:"id"`
			Status string `json:"status"`
		}
		q := url.Values{"filename": {d.Name()}, "size": {fmt.Sprint(fi.Size())}}
		if err := c.json(ctx, "GET", "/api/recordings?"+q.Encode(), nil, &existing); err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		done := false
		for _, r := range existing {
			if r.Status != "uploading" {
				done = true
				continue
			}
			// an upload killed mid-way (SIGKILL, sleep, power loss) never aborted; drop it and upload again
			if err := c.json(ctx, "DELETE", fmt.Sprintf("/api/uploads/%d", r.ID), nil, nil); err != nil {
				return fmt.Errorf("%s: drop stale upload %d: %w", path, r.ID, err)
			}
		}
		if done {
			return nil
		}
		rel, err := filepath.Rel(root, filepath.Dir(path))
		if err != nil {
			return err
		}
		folderID, err := folderFor(rel)
		if err != nil {
			return err
		}
		if err := upload(ctx, c, path, fi.Size(), folderID); err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		added++
		fmt.Println("uploaded", path)
		return ctx.Err()
	})
	fmt.Printf("%d file(s) uploaded\n", added)
	return err
}

// upload sends one file through the multipart upload API; the recording is queued on completion.
func upload(ctx context.Context, c *client, path string, size int64, folderID *int64) (err error) {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	var res struct {
		RecordingID int64 `json:"recording_id"`
	}
	if err := c.json(ctx, "POST", "/api/uploads", map[string]any{"filename": filepath.Base(path), "size": size, "folder_id": folderID}, &res); err != nil {
		return err
	}
	base := fmt.Sprintf("/api/uploads/%d", res.RecordingID)
	defer func() {
		if err != nil {
			c.json(context.WithoutCancel(ctx), "DELETE", base, nil, nil) // best-effort abort
		}
	}()
	parts, err := c.uploadParts(ctx, f, func(n int) string { return fmt.Sprintf("%s/%d", base, n) })
	if err != nil {
		return err
	}
	return c.json(ctx, "POST", base+"/complete", map[string]any{"parts": parts}, nil)
}
