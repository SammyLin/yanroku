// Export / import routes end to end on one Worker (sh test/transfer.sh): user A exports, user B (who already has a folder
// and a person of the same names) imports through the routes in order — merge rules, ids remapped, audio identical,
// importing rows invisible and not completable through /api/uploads, a second import skipped, and the switch off → 404.
import assert from "node:assert/strict";

const BASE = process.env.BASE!, OFF = process.env.OFF!;
type H = Record<string, string>;
const A: H = { "X-Test-Uid": "1" }, B: H = { "X-Test-Uid": "2" }, RUN: H = { "X-Test-Runner": "1" };
const R = { runner: "transfer" };

async function call(base: string, h: H, method: string, path: string, body?: unknown) {
  const headers: H = { ...h };
  let payload: BodyInit | undefined;
  if (body instanceof Uint8Array) (payload = body), (headers["Content-Type"] = "application/octet-stream");
  else if (body != null) (payload = JSON.stringify(body)), (headers["Content-Type"] = "application/json");
  const r = await fetch(base + path, { method, headers, body: payload });
  const buf = new Uint8Array(await r.arrayBuffer());
  const text = new TextDecoder().decode(buf);
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, buf };
}
const ok = async (p: ReturnType<typeof call>) => { const r = await p; assert.ok(r.status < 300, `${r.status} ${r.text.slice(0, 200)}`); return r.json; };
const api = (h: H, method: string, path: string, body?: unknown) => ok(call(BASE, h, method, path, body));
const runner = (method: string, path: string, body?: unknown) => api(RUN, method, path, body);
const EMB = Array.from({ length: 16 }, (_, i) => Math.cos(i)), MODEL = "eres2net-large-zh-cn";

// upload → runner: claim, transcript, play, done
async function record(h: H, filename: string, folder_id: number | null, text: string, audio: string) {
  const { recording_id: rid } = await api(h, "POST", "/api/uploads", { filename, size: 4, folder_id });
  const { etag } = await api(h, "PUT", `/api/uploads/${rid}/1`, new TextEncoder().encode("abcd"));
  await api(h, "POST", `/api/uploads/${rid}/complete`, { parts: [{ part: 1, etag }] });
  const { job } = await runner("POST", "/api/runner/claim", R);
  assert.equal(job.id, rid);
  await runner("POST", `/api/runner/recordings/${rid}/transcript`, { ...R, duration_s: 2,
    speakers: [{ label: "SPEAKER_00", display_name: "Speaker 1", embedding: EMB, emb_model: MODEL }, { label: "SPEAKER_01", display_name: "Speaker 2" }],
    segments: [{ start_ms: 0, end_ms: 1000, speaker: 0, text_raw: text }, { start_ms: 1000, end_ms: 2000, speaker: 1, text_raw: "ok" }] });
  await runner("PUT", `/api/runner/recordings/${rid}/play?runner=transfer`, new TextEncoder().encode(audio));
  await runner("POST", `/api/runner/recordings/${rid}/done`, R);
  return rid as number;
}

// ---- A: Work/Sub folders, two recordings (speaker named Alice → voiceprint), settings, an ask citing both
const work = (await api(A, "POST", "/api/folders", { name: "Work" })).id;
const sub = (await api(A, "POST", "/api/folders", { name: "Sub", parent_id: work })).id;
const r1 = await record(A, "one.m4a", sub, "第一份", "AUDIO-ONE");
const r2 = await record(A, "two.m4a", null, "second", "AUDIO-TWO");
const seg = (await api(A, "GET", `/api/recordings/${r1}`)).segments[0].id;
await api(A, "POST", `/api/segments/${seg}/speaker`, { name: "Alice" });
const alice = (await api(A, "GET", "/api/persons"))[0].id;
await api(A, "PUT", "/api/settings", { about: "A about", stt_lang: "ja", me: alice, vocab: ["Kiroku"] });
const ask = (await api(A, "POST", "/api/asks", { question: "什麼？" })).id;
{
  const { job } = await runner("POST", "/api/runner/claim", { ...R, asks: true });
  assert.equal(job.id, ask);
  await runner("POST", `/api/runner/asks/${ask}/result`, { ...R, answer_md: `見 [[${r1}@00:01, ${r2}@00:02]]`, sources: [r1, r2] });
}

// ---- B already has a "Work" folder, a person "Alice" and its own about
const bWork = (await api(B, "POST", "/api/folders", { name: "Work" })).id;
const bRec = await record(B, "mine.m4a", null, "B's own", "B-AUDIO");
const bSeg = (await api(B, "GET", `/api/recordings/${bRec}`)).segments[0].id;
await api(B, "POST", `/api/segments/${bSeg}/speaker`, { name: "Alice" });
const bAlice = (await api(B, "GET", "/api/persons"))[0].id;
await api(B, "PUT", "/api/settings", { about: "B about" });

// ---- export (A)
const idx = await api(A, "GET", "/api/export");
assert.equal(idx.manifest.format, "yanroku-export");
assert.deepEqual(idx.recordings.map((r: { id: number }) => r.id).sort(), [r1, r2].sort());

// ---- import (B), in order
async function importAll() {
  const map = await api(B, "POST", "/api/import/meta", { manifest: idx.manifest, folders: idx.folders, people: idx.people, settings: idx.settings, vocab: idx.vocab });
  const recMap: Record<number, number> = {};
  const results: string[] = [];
  for (const r of idx.recordings) {
    const d = await api(A, "GET", `/api/export/recordings/${r.id}`);
    const audio = (await call(BASE, A, "GET", `/media/${r.id}`)).buf;
    const speakerIds = new Set(d.speakers.map((s: { id: number }) => s.id));
    const voiceprints = idx.people.flatMap((p: any) => p.voiceprints.filter((v: any) => speakerIds.has(v.speaker_id)).map((v: any) => ({ ...v, person_id: map.people[p.id] })));
    const res = await api(B, "POST", "/api/import/recordings", { ...d, folder_id: map.folders[d.recording.folder_id] ?? null, people: map.people, voiceprints, size: audio.length });
    recMap[r.id] = res.recording_id;
    if (res.skipped) { results.push("skipped"); continue; }
    const listed = await api(B, "GET", "/api/recordings");
    assert.ok(!listed.some((x: { id: number }) => x.id === res.recording_id), "an importing row shows in the list");
    const early = await call(BASE, B, "POST", `/api/uploads/${res.recording_id}/complete`, { parts: [{ part: 1, etag: "x" }] });
    assert.equal(early.status, 409, "regular upload complete accepted an importing row");
    const { etag } = await api(B, "PUT", `/api/uploads/${res.recording_id}/1`, audio);
    await api(B, "POST", `/api/import/recordings/${res.recording_id}/complete`, { parts: [{ part: 1, etag }] });
    results.push("imported");
  }
  await api(B, "POST", "/api/import/asks", { asks: idx.asks, recordings: recMap });
  return { map, recMap, results };
}
const first = await importAll();
assert.deepEqual(first.results, ["imported", "imported"]);
assert.equal(first.map.folders[work], bWork, "same-name folder reused");
assert.equal(first.map.people[alice], bAlice, "same-name person reused");

// ---- B's account now
const n1 = first.recMap[r1], n2 = first.recMap[r2];
const list = await api(B, "GET", "/api/recordings");
assert.deepEqual(list.map((r: { id: number }) => r.id).sort(), [bRec, n1, n2].sort());
const d1 = await api(B, "GET", `/api/recordings/${n1}`);
assert.equal(d1.recording.status, "done");
assert.equal(d1.recording.title, "one");
assert.deepEqual(d1.segments.map((s: { text_raw: string }) => s.text_raw), ["第一份", "ok"]);
assert.equal(d1.speakers[0].display_name, "Alice");
assert.equal(d1.speakers[0].person_id, bAlice);
const bSub = (await api(B, "GET", "/api/folders")).find((f: { name: string }) => f.name === "Sub");
assert.equal(bSub.parent_id, bWork);
assert.equal(d1.recording.folder_id, bSub.id);
assert.equal((await call(BASE, B, "GET", `/media/${n1}`)).text, "AUDIO-ONE");
assert.equal((await call(BASE, B, "GET", `/media/${n2}`)).text, "AUDIO-TWO");
const people = await api(B, "GET", "/api/persons");
assert.equal(people.length, 1);
assert.equal(people[0].prints, 2, "imported voiceprint added to B's Alice");
const settings = await api(B, "GET", "/api/settings");
assert.equal(settings.about, "B about", "B's own setting kept");
assert.equal(settings.stt_lang, "ja");
assert.equal(settings.me, bAlice);
assert.deepEqual(settings.vocab, ["Kiroku"]);
const asks = await api(B, "GET", "/api/asks");
const imported = await api(B, "GET", `/api/asks/${asks[0].id}`);
assert.equal(imported.answer_md, `見 [[${n1}@00:01, ${n2}@00:02]]`);
assert.deepEqual(typeof imported.sources === "string" ? JSON.parse(imported.sources) : imported.sources, [n1, n2]);
assert.equal((await runner("POST", "/api/runner/claim", R)).job, null, "an imported recording was queued for a runner");

// ---- again: everything skipped, nothing duplicated
const second = await importAll();
assert.deepEqual(second.results, ["skipped", "skipped"]);
assert.equal((await api(B, "GET", "/api/recordings")).length, 3);

// ---- a broken manifest is refused before anything is written
const bad = await call(BASE, B, "POST", "/api/import/meta", { manifest: { ...idx.manifest, version: 2 }, folders: [{ id: 99, parent_id: null, name: "Never" }], people: [], settings: {}, vocab: [] });
assert.equal(bad.status, 400);
assert.ok(!(await api(B, "GET", "/api/folders")).some((f: { name: string }) => f.name === "Never"));

// ---- switch off: config says so and every route 404s
assert.equal((await api(B, "GET", "/api/config")).transfer, true);
assert.equal((await ok(call(OFF, B, "GET", "/api/config"))).transfer, false);
for (const [m, p] of [["GET", "/api/export"], ["GET", "/api/export/recordings/1"], ["POST", "/api/import/meta"], ["POST", "/api/import/recordings"],
  ["POST", "/api/import/recordings/1/complete"], ["POST", "/api/import/asks"]] as const)
  assert.equal((await call(OFF, B, m, p, m === "POST" ? {} : undefined)).status, 404, `${m} ${p} with the switch off`);
console.log("transfer-api ok");
