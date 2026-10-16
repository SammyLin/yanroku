// 設定 › 搬家: export an account to a zip and import such a zip into another server (src/transfer.ts has the routes, docs
// SPEC "Transfer"). Plain script: sets globalThis.YanrokuTransfer; needs public/zip.js. The caller passes a client —
// { api(path, {method, body}) → JSON, media(id) → Blob, upload(rid, partNo, Blob) → {etag} } — so index.html uses its
// own fetch helpers and node tests drive the same code against a Worker.
(() => {
  const FORMAT = "yanroku-export", VERSION = 1;
  const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? v[k] : m));
  const t = (s, v) => (globalThis.yanroku?.t ? globalThis.yanroku.t(s, v) : fill(s, v));
  const Z = () => globalThis.YanrokuZip;

  /** Everything exportable → { blob: the zip, skipped: recordings left out (unfinished / failed) }. */
  async function exportAll(client, onProgress = () => {}) {
    const idx = await client.api("/api/export");
    const w = new (Z().ZipWriter)();
    const recordings = [];
    let bytes = 0;
    for (const [i, r] of idx.recordings.entries()) {
      const detail = await client.api(`/api/export/recordings/${r.id}`);
      const audio = await client.media(r.id);
      await w.add(`audio/${r.id}.m4a`, audio);
      recordings.push(detail);
      bytes += audio.size;
      onProgress({ done: i + 1, total: idx.recordings.length, bytes, title: r.title });
    }
    const manifest = { ...idx.manifest, counts: { recordings: recordings.length, people: idx.people.length, folders: idx.folders.length, asks: idx.asks.length } };
    const data = { folders: idx.folders, people: idx.people, settings: idx.settings, vocab: idx.vocab, asks: idx.asks, recordings };
    await w.add("manifest.json", JSON.stringify(manifest, null, 2));
    await w.add("data.json", JSON.stringify(data));
    return { blob: w.finish(), skipped: idx.left_out ?? [] };
  }

  /** Opens a zip and checks it is ours → { manifest, data, entries }; throws a readable message otherwise (no requests). */
  async function inspect(file) {
    let entries;
    try { entries = await Z().readZip(file); } catch { throw new Error(t("這不是 Yanroku 匯出的檔案")); }
    const json = async (name) => {
      const e = entries.get(name);
      if (!e) throw new Error(t("這不是 Yanroku 匯出的檔案"));
      try { return JSON.parse(await e.blob().text()); } catch { throw new Error(t("匯出檔已損毀：{name}", { name })); }
    };
    const manifest = await json("manifest.json");
    if (manifest?.format !== FORMAT) throw new Error(t("這不是 Yanroku 匯出的檔案"));
    if (manifest.version !== VERSION) throw new Error(t("這個匯出檔的格式版本（{version}）比這台伺服器新，請先更新伺服器。", { version: manifest.version }));
    return { manifest, data: await json("data.json"), entries };
  }

  /** Imports a zip (File / Blob) → { imported, skipped, failed: [{title, error}] }. Running it again skips what is done. */
  async function importZip(file, client, onProgress = () => {}) {
    const { manifest, data, entries } = await inspect(file);
    const map = await client.api("/api/import/meta", { method: "POST",
      body: { manifest, folders: data.folders, people: data.people, settings: data.settings, vocab: data.vocab } });
    // voiceprints travel with their recording's speaker, under the person they belong to (now this account's)
    const prints = data.people.flatMap((p) => (p.voiceprints ?? []).map((v) => ({ ...v, person_id: map.people[p.id] })))
      .filter((v) => v.person_id != null);
    const recMap = {}, imported = [], skipped = [], failed = [];
    for (const [i, rec] of data.recordings.entries()) {
      const title = rec.recording.title;
      try {
        const audio = entries.get(`audio/${rec.recording.id}.m4a`);
        if (!audio) throw new Error(t("匯出檔缺少這份錄音的音檔"));
        const speakers = new Set(rec.speakers.map((s) => s.id));
        const res = await client.api("/api/import/recordings", { method: "POST", body: { ...rec, size: audio.size, people: map.people,
          folder_id: map.folders[rec.recording.folder_id] ?? null, voiceprints: prints.filter((v) => speakers.has(v.speaker_id)) } });
        recMap[rec.recording.id] = res.recording_id;
        if (res.skipped) { skipped.push(title); continue; }
        const blob = audio.blob(), parts = [];
        for (let n = 0; n === 0 || n * res.part_size < blob.size; n++) {
          const { etag } = await client.upload(res.recording_id, n + 1, blob.slice(n * res.part_size, (n + 1) * res.part_size));
          parts.push({ part: n + 1, etag });
        }
        await client.api(`/api/import/recordings/${res.recording_id}/complete`, { method: "POST", body: { parts } });
        imported.push(title);
      } catch (e) {
        failed.push({ title, error: e.message || String(e) });
      } finally {
        onProgress({ done: i + 1, total: data.recordings.length, title });
      }
    }
    await client.api("/api/import/asks", { method: "POST", body: { asks: data.asks, recordings: recMap } });
    return { imported, skipped, failed };
  }

  globalThis.YanrokuTransfer = { exportAll, inspect, importZip };
})();
