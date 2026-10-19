// node test/local-r2.test.ts — web/local/r2.ts behaves like R2 where src/ depends on it, and serveR2 works on top of it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

registerHooks({ resolve: (s, c, next) => { try { return next(s, c); } catch (e) { if (s.startsWith(".")) return next(`${s}.ts`, c); throw e; } } });
const { LocalR2 } = await import("../local/r2.ts");
const { serveR2 } = await import("../src/http.ts");

const dir = mkdtempSync(join(tmpdir(), "yanroku-r2-"));
const r2 = new LocalR2(dir);
const text = async (o: { body: ReadableStream } | null) => (o ? new Response(o.body).text() : null);
try {
  // put / head / get (whole, range, suffix) / delete
  const put = await r2.put("u/1/rec/1/play.m4a", new Blob(["0123456789"]).stream(), { httpMetadata: { contentType: "audio/mp4" } });
  assert.equal(put.size, 10);
  assert.equal(put.etag, createHash("md5").update("0123456789").digest("hex"));
  assert.equal((await r2.head("u/1/rec/1/play.m4a"))?.size, 10);
  assert.equal(await text(await r2.get("u/1/rec/1/play.m4a")), "0123456789");
  assert.equal(await text(await r2.get("u/1/rec/1/play.m4a", { range: { offset: 2, length: 3 } })), "234");
  assert.equal(await text(await r2.get("u/1/rec/1/play.m4a", { range: { suffix: 4 } })), "6789");
  assert.equal(await r2.get("missing"), null);
  assert.equal(await r2.head("missing"), null);
  for (const bad of ["../x", "/abs", "a//b", "a/./b", ""]) await assert.rejects(r2.put(bad, "x"), /invalid object key/);

  // serveR2 (the Worker's media route) on top: 200, 206, 416, Content-Type from httpMetadata
  const req = (range?: string) => new Request("http://x/media/1", { headers: range ? { Range: range } : {} });
  let r = await serveR2(req(), r2 as never, "u/1/rec/1/play.m4a");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Content-Type"), "audio/mp4");
  assert.equal(await r.text(), "0123456789");
  r = await serveR2(req("bytes=8-"), r2 as never, "u/1/rec/1/play.m4a");
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("Content-Range"), "bytes 8-9/10");
  assert.equal(await r.text(), "89");
  assert.equal((await serveR2(req("bytes=20-30"), r2 as never, "u/1/rec/1/play.m4a")).status, 416);

  await r2.delete(["u/1/rec/1/play.m4a", "never-existed"]);
  assert.equal(await r2.head("u/1/rec/1/play.m4a"), null);

  // multipart: parts in any order, complete in part order, etags checked; abort removes the parts
  const up = await r2.createMultipartUpload("u/1/rec/2/source.wav");
  const p2 = await r2.resumeMultipartUpload("u/1/rec/2/source.wav", up.uploadId).uploadPart(2, new Blob(["world"]).stream());
  const p1 = await r2.resumeMultipartUpload("u/1/rec/2/source.wav", up.uploadId).uploadPart(1, new Blob(["hello "]).stream());
  await assert.rejects(r2.resumeMultipartUpload("u/1/rec/2/source.wav", up.uploadId).complete([p1, { partNumber: 2, etag: "0".repeat(32) }]), /etag mismatch/);
  await assert.rejects(r2.resumeMultipartUpload("u/1/rec/2/other.wav", up.uploadId).complete([p1, p2]), /another key/);
  await assert.rejects(r2.resumeMultipartUpload("u/1/rec/2/source.wav", up.uploadId).complete([p1, p1, p2]), /duplicate/);
  const done = await r2.resumeMultipartUpload("u/1/rec/2/source.wav", up.uploadId).complete([p2, p1]);
  assert.equal(done.size, 11);
  assert.match(done.etag, /^[0-9a-f]{32}-2$/);
  assert.equal(await text(await r2.get("u/1/rec/2/source.wav")), "hello world");
  await assert.rejects(r2.resumeMultipartUpload("u/1/rec/2/source.wav", up.uploadId).uploadPart(3, "x"), /not found/); // completed = gone

  const gone = await r2.createMultipartUpload("u/1/rec/3/source.wav");
  await r2.resumeMultipartUpload("u/1/rec/3/source.wav", gone.uploadId).uploadPart(1, "x");
  await r2.resumeMultipartUpload("u/1/rec/3/source.wav", gone.uploadId).abort();
  await assert.rejects(r2.resumeMultipartUpload("u/1/rec/3/source.wav", gone.uploadId).complete([{ partNumber: 1, etag: "x" }]), /not found/);
  assert.throws(() => r2.resumeMultipartUpload("k", "../../etc"), /invalid upload id/);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("local r2 ok");
