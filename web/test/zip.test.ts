// node test/zip.test.ts — public/zip.js: STORE zip writer / reader with zip64, round trip.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

await import("../public/zip.js");
const Z = (globalThis as any).YanrokuZip;

assert.equal(Z.crc32(new TextEncoder().encode("123456789")) >>> 0, 0xcbf43926);
assert.equal(Z.crc32(new TextEncoder().encode("6789"), Z.crc32(new TextEncoder().encode("12345"))) >>> 0, 0xcbf43926, "incremental");

// zip64Always exercises the zip64 records an archive over 4 GB needs, without writing 4 GB in a unit test
for (const zip64Always of [false, true]) {
  const big = new Uint8Array(randomBytes(3 * 1024 * 1024));
  const w = new Z.ZipWriter({ zip64Always });
  await w.add("manifest.json", JSON.stringify({ a: 1 }));
  await w.add("audio/1.m4a", new Blob([big]));
  await w.add("音檔/空.txt", new Uint8Array());
  const blob: Blob = w.finish();
  const entries = await Z.readZip(blob);
  assert.deepEqual([...entries.keys()], ["manifest.json", "audio/1.m4a", "音檔/空.txt"], `names (zip64 ${zip64Always})`);
  assert.equal(await entries.get("manifest.json").blob().text(), '{"a":1}');
  assert.deepEqual(new Uint8Array(await entries.get("audio/1.m4a").blob().arrayBuffer()), big);
  assert.equal(entries.get("audio/1.m4a").size, big.length);
  assert.equal(entries.get("audio/1.m4a").crc >>> 0, Z.crc32(big) >>> 0);
  assert.equal(entries.get("音檔/空.txt").size, 0);
}

// not a zip, or a compressed (deflate) entry → refused
await assert.rejects(Z.readZip(new Blob(["not a zip at all"])), /zip/);
{
  const w = new Z.ZipWriter({});
  await w.add("a.txt", "hello");
  const bytes = new Uint8Array(await w.finish().arrayBuffer());
  const cd = bytes.findLastIndex((_, i) => bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 1 && bytes[i + 3] === 2);
  bytes[cd + 10] = 8; // method = deflate in the central directory
  await assert.rejects(Z.readZip(new Blob([bytes])), /unsupported zip/);
}
console.log("zip ok");
