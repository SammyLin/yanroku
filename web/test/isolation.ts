// Two-user isolation suite, shared by every deployment of the server. User A creates one of everything (folder, upload
// driven through the runner to done, summary, ask, person, settings, push subscription, vocab suggestion); user B is then
// pointed at every user route with A's ids: GET → 404 or a list without A's rows; writes → 404 (or the not-found answer)
// and A re-reads to confirm nothing changed; A's voiceprint never labels or is suggested for B. Every route in `routes`
// must be hit by a case (a new route fails until one is added); `cases` adds cases for a deployment's extra routes.
// Core runs it via test/isolation.sh (fake identities); other entries call runIsolation with real tokens.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

export type Headers = Record<string, string>;
export type Res = { status: number; json: any; text: string };
export type Case = [method: string, samplePath: string, check: () => Promise<unknown>];
type Call = (auth: Headers | null, method: string, path: string, body?: unknown, headers?: Headers) => Promise<Res>;
export type CaseKit = {
  A: Headers; B: Headers; call: Call; ok: (p: Promise<Res>) => Promise<any>; status: (p: Promise<Res>, want: number, what: string) => Promise<any>;
  ids: { recA: number; recB: number; fA: number; pA: number; sumA: number; askA: number };
};
export interface IsolationOptions {
  base: string; // http://127.0.0.1:<port>
  tokenA: Headers; tokenB: Headers; runner: Headers; // request headers that authenticate user A, user B, the runner
  routes: [string, RegExp, unknown][]; // every route the Worker serves (core routes + any extraRoutes)
  cases?: (kit: CaseKit) => Case[];
  d1: string[]; // `wrangler d1 execute` args naming the database, e.g. ["noteapp"]
  dbDir: string; // the --persist-to dir the Worker runs on
  forgetRunnerStatus?: number; // DELETE /api/runners/<online runner>: 409 in core
}

export async function runIsolation(o: IsolationOptions) {
  // ---- Worker calls
  async function call(auth: Headers | null, method: string, path: string, body?: unknown, headers: Headers = {}): Promise<Res> {
    const h: Headers = { ...auth, ...headers };
    let payload: BodyInit | undefined;
    if (body instanceof Uint8Array) (payload = body), (h["Content-Type"] ??= "application/octet-stream");
    else if (body != null) (payload = JSON.stringify(body)), (h["Content-Type"] = "application/json");
    const r = await fetch(o.base + path, { method, headers: h, body: payload });
    const text = await r.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  }
  const ok = async (p: Promise<Res>) => {
    const r = await p;
    assert.ok(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status} ${r.text.slice(0, 200)}`);
    return r.json;
  };
  const status = async (p: Promise<Res>, want: number, what: string) => {
    const r = await p;
    assert.equal(r.status, want, `${what}: ${r.status} ${r.text.slice(0, 200)}`);
    return r.json;
  };
  const runner = (method: string, path: string, body?: unknown) => ok(call(o.runner, method, path, body));
  const R = { runner: "idor" };

  const EMB = Array.from({ length: 16 }, (_, i) => Math.cos(i)); // the same voice in A's and B's recordings
  const OTHER = Array.from({ length: 16 }, (_, i) => Math.sin(i * 3));
  const MODEL = "eres2net-large-zh-cn";

  // upload → runner: claim, transcript, play, speaker-embeddings, done
  async function record(tok: Headers, filename: string, folder_id: number | null, text: string) {
    const { recording_id: rid } = await ok(call(tok, "POST", "/api/uploads", { filename, size: 4, folder_id }));
    const { etag } = await ok(call(tok, "PUT", `/api/uploads/${rid}/1`, new TextEncoder().encode("abcd")));
    await ok(call(tok, "POST", `/api/uploads/${rid}/complete`, { parts: [{ part: 1, etag }] }));
    const { job } = await runner("POST", "/api/runner/claim", R);
    assert.equal(job?.id, rid, "runner claims the new recording");
    assert.equal(job.kind, "recording");
    await runner("POST", `/api/runner/recordings/${rid}/transcript`, { ...R, duration_s: 2,
      speakers: [{ label: "SPEAKER_00", display_name: "Speaker 1", embedding: EMB, emb_model: MODEL },
        { label: "SPEAKER_01", display_name: "Speaker 2", embedding: OTHER, emb_model: MODEL }],
      segments: [{ start_ms: 0, end_ms: 1000, speaker: 0, text_raw: text }, { start_ms: 1000, end_ms: 2000, speaker: 1, text_raw: "ok" }] });
    await runner("PUT", `/api/runner/recordings/${rid}/play?runner=idor`, new TextEncoder().encode("m4a!"));
    const d = await ok(call(tok, "GET", `/api/recordings/${rid}`));
    await runner("POST", `/api/runner/recordings/${rid}/speaker-embeddings`, { speakers: d.speakers.map((s: { id: number }, i: number) => ({ id: s.id, embedding: i ? OTHER : EMB, emb_model: MODEL })) });
    await runner("POST", `/api/runner/recordings/${rid}/done`, R);
    return rid as number;
  }

  const A = o.tokenA, B = o.tokenB;

  // ---- A creates one of everything
  const fA = (await ok(call(A, "POST", "/api/folders", { name: "A-folder" }))).id;
  const recA = await record(A, "a-secret.m4a", fA, "hello A-term secret");
  const dA = await ok(call(A, "GET", `/api/recordings/${recA}`));
  const [segA, seg2A] = dA.segments.map((s: { id: number }) => s.id);
  await ok(call(A, "POST", `/api/segments/${segA}/speaker`, { name: "Alice" })); // enrols EMB as A's voiceprint of Alice
  const pA = (await ok(call(A, "GET", "/api/persons")))[0].id;
  await ok(call(A, "PUT", "/api/settings", { about: "A-about-secret", me: pA, vocab: ["A-vocab"] }));
  const sumA = (await ok(call(A, "POST", `/api/recordings/${recA}/summaries`, { template_id: "meeting" }))).id;
  {
    const { job } = await runner("POST", "/api/runner/claim", R);
    assert.equal(job.kind, "summary");
    assert.equal(job.id, sumA);
    assert.equal(job.settings.about, "A-about-secret", "claim carries the job owner's settings");
    assert.equal(job.settings.me, "Alice");
    await runner("POST", `/api/runner/summaries/${sumA}/result`, { ...R, content_md: "# A summary" });
  }
  const askA = (await ok(call(A, "POST", "/api/asks", { question: "A-question?" }))).id;
  {
    const { job } = await runner("POST", "/api/runner/claim", { ...R, asks: true });
    assert.equal(job.kind, "ask");
    assert.deepEqual(job.index.map((r: { id: number }) => r.id), [recA]);
    await runner("POST", `/api/runner/asks/${askA}/result`, { ...R, answer_md: `see [[${recA}@00:00]]`, sources: [recA] });
  }
  {
    const { job } = await runner("POST", "/api/runner/claim", { ...R, vocab: true });
    assert.equal(job.kind, "vocab");
    assert.deepEqual(job.recordings.map((r: { id: number }) => r.id), [recA]);
    assert.deepEqual(job.vocab, ["A-vocab"]);
    await runner("POST", `/api/runner/vocab/${job.id}/result`, { ...R, terms: [{ term: "A-term", misheard: ["A-turm"], kind: "term" }] });
  }
  const sugA = await ok(call(A, "GET", "/api/vocab/suggestions"));
  assert.deepEqual(sugA.suggestions.map((s: { term: string }) => s.term), ["A-term"]);
  await ok(call(A, "POST", "/api/push/subscribe", { endpoint: "https://push.example/a", keys: { p256dh: "pa", auth: "aa" } }));

  // ---- B: own data; A's voiceprint must never label or be suggested for B's speaker with the very same voice
  const recB = await record(B, "b.m4a", null, "hello from B");
  {
    const d = await ok(call(B, "GET", `/api/recordings/${recB}`));
    for (const s of d.speakers) {
      assert.equal(s.person_id, null, "B's speaker matched A's voiceprint");
      assert.equal(s.suggest, null, "B's speaker got a suggestion from A's voiceprint");
      assert.match(s.display_name, /^Speaker \d$/);
    }
    const mine = await ok(call(A, "GET", `/api/recordings/${recA}`));
    assert.equal(mine.speakers[0].display_name, "Alice");
  }
  const askB = (await ok(call(B, "POST", "/api/asks", { question: "B-question?" }))).id;
  {
    const { job } = await runner("POST", "/api/runner/claim", { ...R, asks: true });
    assert.equal(job.id, askB);
    assert.deepEqual(job.index.map((r: { id: number }) => r.id), [recB], "Ask index only holds the asker's recordings");
    const t = await runner("GET", `/api/runner/asks/${askB}/transcripts?runner=idor&ids=${recA},${recB}`);
    assert.deepEqual(t.map((r: { id: number }) => r.id), [recB], "Ask retrieval only reads the asker's recordings");
    await runner("POST", `/api/runner/asks/${askB}/result`, { ...R, answer_md: "B answer", sources: [recB] });
  }

  // ---- the matrix: [method, sample path, check]. Every route must be hit by at least one case.
  const notIn = (list: { id: number }[], idv: number, what: string) => assert.ok(!list.some((x) => x.id === idv), `${what} leaks A's row`);
  const n404 = (method: string, path: string, body?: unknown): [string, string, () => Promise<unknown>] =>
    [method, path, () => status(call(B, method, path, body), 404, `B ${method} ${path}`)];
  const runnerOnly = (method: string, path: string, body: unknown = R): [string, string, () => Promise<unknown>] =>
    [method, path, async () => { const r = await call(B, method, path, body); assert.ok([401, 403].includes(r.status), `user B on runner route ${method} ${path}: ${r.status}`); }];

  const cases: Case[] = [
    n404("GET", `/media/${recA}`),
    ["GET", "/api/recordings", async () => {
      for (const q of ["", "?trash=1", "?q=secret", "?filename=a-secret.m4a", `?folder=${fA}`, "?view=recent", "?size=4"])
        notIn(await ok(call(B, "GET", `/api/recordings${q}`)), recA, `list ${q}`);
    }],
    n404("GET", `/api/recordings/${recA}`),
    ["PATCH", `/api/recordings/${recA}`, async () => {
      await status(call(B, "PATCH", `/api/recordings/${recA}`, { title: "pwned", folder_id: null }), 404, "B patch A's recording");
      await status(call(B, "PATCH", `/api/recordings/${recB}`, { folder_id: fA }), 400, "B files into A's folder");
    }],
    ["DELETE", `/api/recordings/${recA}`, async () => {
      await status(call(B, "DELETE", `/api/recordings/${recA}`), 404, "B trash");
      await status(call(B, "DELETE", `/api/recordings/${recA}?purge=1`), 404, "B purge");
    }],
    n404("POST", `/api/recordings/${recA}/restore`),
    n404("POST", `/api/recordings/${recA}/retranscribe`, { language: "en" }),
    n404("PATCH", `/api/segments/${segA}`, { text: "pwned" }),
    ["POST", `/api/segments/${seg2A}/speaker`, async () => {
      await status(call(B, "POST", `/api/segments/${seg2A}/speaker`, { name: "Mallory" }), 404, "B renames A's speaker");
      await status(call(B, "POST", `/api/segments/${seg2A}/speaker`, { name: "Mallory", scope: "one" }), 404, "B reassigns A's segment");
    }],
    ["GET", "/api/people", async () => assert.ok(!(await ok(call(B, "GET", "/api/people"))).includes("Alice"))],
    ["GET", "/api/persons", async () => notIn(await ok(call(B, "GET", "/api/persons")), pA, "persons")],
    ["PATCH", `/api/persons/${pA}`, async () => {
      await status(call(B, "PATCH", `/api/persons/${pA}`, { name: "Mallory" }), 404, "B renames A's person");
      await status(call(B, "PATCH", `/api/persons/${pA}`, { name: "Mallory", merge: true }), 404, "B merges A's person");
    }],
    n404("DELETE", `/api/persons/${pA}`),
    ["GET", "/api/settings", async () => {
      const s = await ok(call(B, "GET", "/api/settings"));
      assert.notEqual(s.about, "A-about-secret");
      assert.deepEqual(s.vocab, []);
    }],
    ["PUT", "/api/settings", async () => {
      await status(call(B, "PUT", "/api/settings", { me: pA }), 400, "B points me at A's person");
      assert.equal((await ok(call(B, "GET", "/api/settings"))).me, null);
    }],
    ["GET", "/api/templates", () => ok(call(B, "GET", "/api/templates"))],
    n404("POST", `/api/recordings/${recA}/summaries`, { template_id: "meeting" }),
    n404("DELETE", `/api/summaries/${sumA}`),
    ["GET", "/api/folders", async () => notIn(await ok(call(B, "GET", "/api/folders")), fA, "folders")],
    ["POST", "/api/folders", async () => {
      await status(call(B, "POST", "/api/folders", { name: "sub", parent_id: fA }), 400, "B nests under A's folder");
      await ok(call(B, "POST", "/api/folders", { name: "A-folder" })); // same name is fine: unique per user
    }],
    n404("PATCH", `/api/folders/${fA}`, { name: "pwned" }),
    n404("DELETE", `/api/folders/${fA}`),
    ["POST", "/api/uploads", () => status(call(B, "POST", "/api/uploads", { filename: "x.m4a", size: 1, folder_id: fA }), 400, "B uploads into A's folder")],
    ["PUT", `/api/uploads/${recA}/1`, () => status(call(B, "PUT", `/api/uploads/${recA}/1`, new Uint8Array([1])), 404, "B uploads a part")],
    n404("POST", `/api/uploads/${recA}/complete`, { parts: [{ part: 1, etag: "x" }] }),
    n404("DELETE", `/api/uploads/${recA}`),
    ["GET", "/api/runners", async () => {
      const r = await ok(call(B, "GET", "/api/runners"));
      assert.ok(!JSON.stringify(r).includes("a-secret") && !JSON.stringify(r).includes("A-question"), "runner list leaks A's jobs");
    }],
    ["DELETE", "/api/runners/idor", () => status(call(B, "DELETE", "/api/runners/idor"), o.forgetRunnerStatus ?? 409, "B forgets an online runner")],
    ["GET", "/api/push/key", () => ok(call(B, "GET", "/api/push/key"))],
    ["POST", "/api/push/subscribe", () => ok(call(B, "POST", "/api/push/subscribe", { endpoint: "https://push.example/b", keys: { p256dh: "pb", auth: "ab" } }))],
    ["DELETE", "/api/push/subscribe", () => ok(call(B, "DELETE", "/api/push/subscribe", { endpoint: "https://push.example/a" }))], // a no-op for B: checked in the DB below
    ["POST", "/api/push/test", () => ok(call(B, "POST", "/api/push/test"))],
    ["POST", "/api/asks", () => ok(call(B, "POST", "/api/asks", { question: "another" }))],
    ["GET", "/api/asks", async () => notIn(await ok(call(B, "GET", "/api/asks")), askA, "asks")],
    n404("GET", `/api/asks/${askA}`),
    n404("DELETE", `/api/asks/${askA}`),
    n404("POST", `/api/asks/${askA}/retry`),
    ["GET", "/api/vocab/suggestions", async () => {
      const s = await ok(call(B, "GET", "/api/vocab/suggestions"));
      assert.deepEqual(s.suggestions, []);
      assert.equal(s.last_scan, null, "B sees A's vocab scan");
    }],
    ["POST", "/api/vocab/suggestions/add", () => ok(call(B, "POST", "/api/vocab/suggestions/add", { term: "A-term" }))], // only B's vocab; A re-checked below
    n404("POST", "/api/vocab/suggestions/dismiss", { term: "A-term" }),
    ["POST", "/api/vocab/scan", async () => { const r = await call(B, "POST", "/api/vocab/scan"); assert.ok([200, 409].includes(r.status), r.text); }],

    // export / import (transfer.ts; the suite runs with TRANSFER_ENABLED=1)
    ["GET", "/api/export", async () => {
      const e = await ok(call(B, "GET", "/api/export"));
      notIn(e.recordings, recA, "export recordings"), notIn(e.folders, fA, "export folders"), notIn(e.people, pA, "export people"), notIn(e.asks, askA, "export asks");
      assert.ok(!JSON.stringify(e).includes("A-about-secret") && !JSON.stringify(e).includes("A-vocab"), "export leaks A's settings");
      const mine = await ok(call(A, "GET", `/api/export/recordings/${recA}`));
      assert.equal(mine.recording.id, recA);
      assert.equal(mine.speakers[0].embedding.length, EMB.length, "A's export carries the speaker embedding");
    }],
    n404("GET", `/api/export/recordings/${recA}`),
    // import: ids in the body are the zip's (another server's), never a way into A's rows
    ["POST", "/api/import/meta", async () => {
      const m = await ok(call(B, "POST", "/api/import/meta", { manifest: { format: "yanroku-export", version: 1 },
        folders: [{ id: fA, parent_id: null, name: "imported" }], people: [{ id: pA, name: "Alice" }], settings: { me: pA }, vocab: [] }));
      assert.notEqual(m.folders[fA], fA, "import reused A's folder"), assert.notEqual(m.people[pA], pA, "import reused A's person");
      assert.notEqual((await ok(call(B, "GET", "/api/settings"))).me, pA, "import pointed B's me at A's person");
    }],
    ["POST", "/api/import/recordings", async () => {
      const r = await ok(call(B, "POST", "/api/import/recordings", { recording: { import_key: "x#1", title: "t" }, folder_id: fA, people: { 1: pA }, size: 1,
        speakers: [{ id: 1, label: "SPEAKER_00", display_name: "x", person_id: 1, auto: 0, embedding: null, emb_model: null }],
        voiceprints: [{ speaker_id: 1, person_id: pA, embedding: EMB, emb_model: MODEL }], segments: [], summaries: [] }));
      const d = await ok(call(B, "GET", `/api/recordings/${r.recording_id}`));
      assert.equal(d.recording.folder_id, null, "import placed B's recording in A's folder");
      assert.equal(d.speakers[0].person_id, null, "import linked B's speaker to A's person");
      assert.ok(!(await ok(call(A, "GET", "/api/persons"))).some((p: { id: number; prints: number }) => p.id === pA && p.prints > 1), "import added a voiceprint to A's person");
    }],
    n404("POST", `/api/import/recordings/${recA}/complete`, { parts: [{ part: 1, etag: "x" }] }),
    ["POST", "/api/import/asks", async () => {
      await ok(call(B, "POST", "/api/import/asks", { asks: [{ question: "imported?", answer_md: `[[1@00:00]]`, sources: [1] }], recordings: { 1: recA } }));
      const mine = await ok(call(B, "GET", "/api/asks"));
      const got = await ok(call(B, "GET", `/api/asks/${mine.find((a: { question: string }) => a.question === "imported?").id}`));
      assert.ok(!JSON.stringify(got).includes(`${recA}@`) && !(got.sources ?? []).includes?.(recA), "imported ask cites A's recording");
    }],

    runnerOnly("POST", "/api/runner/claim"),
    runnerOnly("POST", `/api/runner/recordings/${recA}/heartbeat`),
    runnerOnly("GET", `/api/runner/recordings/${recA}/source`, null),
    runnerOnly("PUT", `/api/runner/recordings/${recA}/play?runner=idor`, new Uint8Array([1])),
    runnerOnly("POST", `/api/runner/recordings/${recA}/play/start?runner=idor`),
    runnerOnly("POST", `/api/runner/recordings/${recA}/play/complete?runner=idor`, { parts: [] }),
    runnerOnly("POST", `/api/runner/recordings/${recA}/transcript`),
    runnerOnly("POST", `/api/runner/recordings/${recA}/speaker-embeddings`, { speakers: [] }),
    runnerOnly("POST", `/api/runner/recordings/${recA}/clean`),
    runnerOnly("POST", `/api/runner/recordings/${recA}/done`),
    runnerOnly("POST", `/api/runner/recordings/${recA}/defer`),
    runnerOnly("POST", `/api/runner/summaries/${sumA}/defer`),
    runnerOnly("POST", `/api/runner/summaries/${sumA}/fail`),
    runnerOnly("POST", `/api/runner/summaries/${sumA}/result`, { ...R, content_md: "pwned" }),
    runnerOnly("GET", `/api/runner/asks/${askA}/transcripts?runner=idor&ids=${recA}`, null),
    runnerOnly("POST", `/api/runner/asks/${askA}/result`, { ...R, answer_md: "pwned" }),
    runnerOnly("POST", `/api/runner/vocab/1/result`, { ...R, terms: [] }),
    ...(o.cases?.({ A, B, call, status, ok, ids: { recA, recB, fA, pA, sumA, askA } }) ?? []),
  ];

  // coverage: every route needs a case whose method and sample path it matches
  const uncovered = o.routes.filter(([m, re]) => !cases.some(([cm, p]) => cm === m && re.test(p.split("?")[0])));
  assert.deepEqual(uncovered.map(([m, re]) => `${m} ${re.source}`), [], "routes without an isolation case (add one to test/isolation.ts, or via cases)");

  for (const [m, p, check] of cases) {
    try { await check(); } catch (e) { console.error(`FAIL ${m} ${p}`); throw e; }
  }

  // ---- no credentials → 401 (user and runner routes)
  await status(call(null, "GET", "/api/recordings"), 401, "no token");
  await status(call(null, "POST", "/api/runner/claim", R), 401, "no token on a runner route");

  // ---- A re-reads everything: B's attempts changed nothing
  {
    const d = await ok(call(A, "GET", `/api/recordings/${recA}`));
    assert.equal(d.recording.title, "a-secret");
    assert.equal(d.recording.deleted_at, null);
    assert.equal(d.recording.folder_id, fA);
    assert.equal(d.recording.status, "done");
    assert.equal(d.recording.language, null);
    assert.deepEqual(d.segments.map((s: { text_clean: string | null }) => s.text_clean), [null, null]);
    assert.deepEqual(d.speakers.map((s: { display_name: string }) => s.display_name), ["Alice", "Speaker 2"]);
    assert.deepEqual(d.summaries.map((s: { id: number }) => s.id), [sumA]);
    const folders = await ok(call(A, "GET", "/api/folders"));
    assert.deepEqual(folders.map((f: { name: string }) => f.name), ["A-folder"]);
    assert.deepEqual((await ok(call(A, "GET", "/api/persons"))).map((p: { name: string; prints: number }) => [p.name, p.prints]), [["Alice", 1]]);
    const s = await ok(call(A, "GET", "/api/settings"));
    assert.equal(s.about, "A-about-secret");
    assert.equal(s.me, pA);
    assert.deepEqual(s.vocab, ["A-vocab"]);
    assert.equal((await ok(call(A, "GET", `/api/asks/${askA}`))).status, "done");
    assert.deepEqual((await ok(call(A, "GET", "/api/vocab/suggestions"))).suggestions.map((x: { term: string }) => x.term), ["A-term"]);
    assert.equal((await call(A, "GET", `/media/${recA}`)).text, "m4a!");
    // push rows have no read API: check the owner in the local D1
    const out = execFileSync("npx", ["wrangler", "d1", "execute", ...o.d1, "--local", "--persist-to", o.dbDir, "--json",
      "--command", "SELECT endpoint, user_id FROM push_subscriptions ORDER BY endpoint"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const subs = JSON.parse(out)[0].results as { endpoint: string; user_id: number }[];
    const owner = (e: string) => subs.find((x) => x.endpoint === e)?.user_id;
    assert.ok(owner("https://push.example/a") && owner("https://push.example/b") && owner("https://push.example/a") !== owner("https://push.example/b"), JSON.stringify(subs));
  }
  console.log(`isolation ok (${o.routes.length} routes, ${cases.length} cases)`);
}
