// public/transfer.js end to end against the Worker (sh test/transfer.sh): user 3 exports with exportAll, user 4 imports the
// zip with importZip; an interrupted import (user 5) is finished by running it again; a zip from a newer format is refused
// before any request. The browser's api / media / upload calls are a fetch client with fake identities.
import assert from "node:assert/strict";

await import("../public/zip.js");
await import("../public/transfer.js");
const T = (globalThis as any).YanrokuTransfer, Z = (globalThis as any).YanrokuZip;
const BASE = process.env.BASE!;
const RUN = { "X-Test-Runner": "1" }, R = { runner: "e2e" }; // runner name follows the job each record() claimed

function client(uid: number, counter = { n: 0 }) {
  const h = { "X-Test-Uid": String(uid) };
  return {
    counter,
    async api(path: string, opt: { method?: string; body?: unknown } = {}) {
      counter.n++;
      const r = await fetch(BASE + path, { method: opt.method ?? "GET", headers: { ...h, ...(opt.body !== undefined && { "Content-Type": "application/json" }) },
        body: opt.body === undefined ? undefined : JSON.stringify(opt.body) });
      const text = await r.text();
      if (!r.ok) throw Object.assign(new Error(text), { status: r.status });
      return text ? JSON.parse(text) : null;
    },
    async media(id: number) { counter.n++; return await (await fetch(`${BASE}/media/${id}`, { headers: h })).blob(); },
    async upload(rid: number, part: number, blob: Blob) {
      counter.n++;
      const r = await fetch(`${BASE}/api/uploads/${rid}/${part}`, { method: "PUT", headers: h, body: blob });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  };
}
const runner = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { ...RUN, ...(!(body instanceof Uint8Array) && { "Content-Type": "application/json" }) },
    body: body instanceof Uint8Array ? body : JSON.stringify(body) });
  assert.ok(r.ok, await r.clone().text());
  return r.json();
};

// ---- user 3: a folder, two finished recordings (one speaker named), an ask citing both
const u3 = client(3);
const folder = (await u3.api("/api/folders", { method: "POST", body: { name: "Projects" } })).id;
async function record(name: string, folder_id: number | null, text: string, audio: string) {
  const { recording_id: rid } = await u3.api("/api/uploads", { method: "POST", body: { filename: name, size: 4, folder_id } });
  const { etag } = await u3.upload(rid, 1, new Blob(["abcd"]));
  await u3.api(`/api/uploads/${rid}/complete`, { method: "POST", body: { parts: [{ part: 1, etag }] } });
  // transfer-api.test.ts (same Worker) leaves a retranscribe queued: claim until ours comes up
  for (let i = 0; ; i++) {
    const { job } = await runner("POST", "/api/runner/claim", { runner: `e2e-${rid}-${i}` });
    assert.ok(job && i < 10, `recording ${rid} never claimed`);
    if (job.kind === "recording" && job.id === rid) { R.runner = `e2e-${rid}-${i}`; break; }
  }
  await runner("POST", `/api/runner/recordings/${rid}/transcript`, { ...R, duration_s: 1,
    speakers: [{ label: "SPEAKER_00", display_name: "Speaker 1", embedding: [0.6, 0.8], emb_model: "eres2net-large-zh-cn" }],
    segments: [{ start_ms: 0, end_ms: 900, speaker: 0, text_raw: text }] });
  await runner("PUT", `/api/runner/recordings/${rid}/play?runner=${R.runner}`, new TextEncoder().encode(audio));
  await runner("POST", `/api/runner/recordings/${rid}/done`, R);
  return rid as number;
}
const a = await record("alpha.m4a", folder, "第一段", "AUDIO-A".repeat(1000));
const b = await record("beta.m4a", null, "second", "AUDIO-B");
const segId = (await u3.api(`/api/recordings/${a}`)).segments[0].id;
await u3.api(`/api/segments/${segId}/speaker`, { method: "POST", body: { name: "Bob" } });
const ask = (await u3.api("/api/asks", { method: "POST", body: { question: "重點？" } })).id;
{
  const { job } = await runner("POST", "/api/runner/claim", { ...R, asks: true });
  assert.equal(job.id, ask);
  await runner("POST", `/api/runner/asks/${ask}/result`, { ...R, answer_md: `[[${a}@00:00]] 和 [[${b}@00:00]]`, sources: [a, b] });
}

// ---- export
const progress: unknown[] = [];
const { blob, skipped } = await T.exportAll(u3, (p: unknown) => progress.push(p));
assert.deepEqual(skipped, []);
assert.ok(progress.length >= 2, "export reports progress");
const entries = await Z.readZip(blob);
assert.ok(entries.has("manifest.json") && entries.has("data.json") && entries.has(`audio/${a}.m4a`) && entries.has(`audio/${b}.m4a`));
const file = new File([blob], "yanroku-export.zip");
const seen = await T.inspect(file);
assert.equal(seen.manifest.counts.recordings, 2);

// ---- one recording's audio can't be fetched: it is skipped with the reason, the rest still export
{
  const flaky = { ...u3, media: async (id: number) => { if (id === b) throw new Error("network down"); return u3.media(id); } };
  const part = await T.exportAll(flaky, () => {});
  assert.deepEqual(part.skipped.map((r: { id: number; error?: string }) => [r.id, r.error]), [[b, "network down"]]);
  const ents = await Z.readZip(part.blob);
  assert.ok(ents.has(`audio/${a}.m4a`) && !ents.has(`audio/${b}.m4a`));
  const data = JSON.parse(await ents.get("data.json").blob().text());
  assert.deepEqual(data.recordings.map((r: { recording: { id: number } }) => r.recording.id), [a]);
}

// ---- import into user 4
const u4 = client(4);
const res = await T.importZip(file, u4, () => {});
assert.equal(res.imported.length, 2), assert.equal(res.skipped.length, 0), assert.deepEqual(res.failed, []);
const list = await u4.api("/api/recordings");
assert.deepEqual(list.map((r: { title: string }) => r.title).sort(), ["alpha", "beta"]);
const na = list.find((r: { title: string }) => r.title === "alpha").id, nb = list.find((r: { title: string }) => r.title === "beta").id;
const d = await u4.api(`/api/recordings/${na}`);
assert.equal(d.segments[0].text_raw, "第一段"), assert.equal(d.speakers[0].display_name, "Bob");
assert.equal((await u4.api("/api/folders")).find((f: { id: number }) => f.id === d.recording.folder_id)?.name, "Projects");
assert.equal(await (await u4.media(na)).text(), "AUDIO-A".repeat(1000));
const asks = await u4.api("/api/asks");
assert.equal((await u4.api(`/api/asks/${asks[0].id}`)).answer_md, `[[${na}@00:00]] 和 [[${nb}@00:00]]`);
assert.equal((await u4.api("/api/persons"))[0].prints, 1, "voiceprint moved");

// ---- interrupted (user 5): meta + one recording created, no audio → a full run finishes it, a third run skips everything
const u5 = client(5);
{
  const meta = await u5.api("/api/import/meta", { method: "POST", body: { manifest: seen.manifest, folders: seen.data.folders, people: seen.data.people,
    settings: seen.data.settings, vocab: seen.data.vocab } });
  const rec = seen.data.recordings[0];
  await u5.api("/api/import/recordings", { method: "POST", body: { ...rec, folder_id: meta.folders[rec.recording.folder_id] ?? null, people: meta.people, voiceprints: [], size: 1 } });
  assert.equal((await u5.api("/api/recordings")).length, 0, "half-imported recording visible");
}
const again = await T.importZip(file, u5, () => {});
assert.equal(again.imported.length, 2, "the interrupted recording is redone");
const third = await T.importZip(file, u5, () => {});
assert.equal(third.imported.length, 0), assert.equal(third.skipped.length, 2);
assert.equal((await u5.api("/api/recordings")).length, 2);
assert.equal((await u5.api("/api/asks")).length, 1);

// ---- a newer format, or not a zip: refused before any request
const w = new Z.ZipWriter();
await w.add("manifest.json", JSON.stringify({ ...seen.manifest, version: 2 }));
await w.add("data.json", "{}");
const u6 = client(6);
await assert.rejects(T.importZip(new File([w.finish()], "x.zip"), u6, () => {}), /版本/);
await assert.rejects(T.inspect(new File(["hello"], "x.zip")), /Yanroku/);
assert.equal(u6.counter.n, 0, "a refused zip made requests");
console.log("transfer-e2e ok");
