// node test/transfer.test.ts — export / import: the TRANSFER_ENABLED switch and the pure merge helpers (transfer-merge.ts).
import assert from "node:assert/strict";
import { parseSettings } from "../src/settings.ts";
import { checkManifest, folderPlan, mapSources, mergeSettings, rewriteCitations, transferEnabled } from "../src/transfer-merge.ts";

assert.equal(transferEnabled({ TRANSFER_ENABLED: "1" } as any), true);
for (const v of [undefined, "", "0", "true", "yes"]) assert.equal(transferEnabled({ TRANSFER_ENABLED: v } as any), false);

// manifest: ours, version 1, else refused before anything is written
const M = { format: "yanroku-export", version: 1, exported_at: "2026-10-17T00:00:00Z", source: "https://a", export_id: "x", voice_model: "m", counts: {} };
assert.equal(checkManifest(M), null);
assert.match(checkManifest({ ...M, version: 2 })!, /version/);
assert.match(checkManifest({ ...M, format: "zip" })!, /Yanroku/);
assert.match(checkManifest(null)!, /Yanroku/);

// settings: keys the account set win, me mapped to the new person, vocab = union (existing first) capped at 200
const many = Array.from({ length: 195 }, (_, i) => `w${i}`);
assert.deepEqual(
  mergeSettings({ about: "mine", vocab: many }, { about: "theirs", stt_lang: "ja", me: 7, vocab: ["w0", ...Array.from({ length: 10 }, (_, i) => `n${i}`)] }, { 7: 70 }, parseSettings),
  { stt_lang: "ja", me: 70, vocab: [...many, "n0", "n1", "n2", "n3", "n4"] });
assert.deepEqual(mergeSettings({}, { me: 9 }, {}, parseSettings), {}); // that person wasn't imported → me dropped
assert.deepEqual(mergeSettings({}, { stt_lang: "de" }, {}, parseSettings), {}); // an invalid value is dropped, not an error
assert.deepEqual(mergeSettings({ me: 3 }, { me: 7 }, { 7: 70 }, parseSettings), {}); // the account's own me wins

// 問問看 citations and sources follow the new recording ids; an id that wasn't imported is dropped
assert.equal(rewriteCitations("見 [[12@01:00, 13@02:00]] 與 [[14@00:05]]", { 12: 112, 14: 114 }), "見 [[112@01:00]] 與 [[114@00:05]]");
assert.equal(rewriteCitations("x [[13@02:00]] y", {}), "x  y");
assert.deepEqual(mapSources([12, 13, 14], { 12: 112, 14: 114 }), [112, 114]);

// folders parents-first; a missing parent (or a cycle) makes it a root
assert.deepEqual(folderPlan([{ id: 3, parent_id: 2, name: "c" }, { id: 2, parent_id: 1, name: "b" }, { id: 1, parent_id: null, name: "a" },
  { id: 9, parent_id: 99, name: "o" }, { id: 5, parent_id: 6, name: "x" }, { id: 6, parent_id: 5, name: "y" }]).map((f) => [f.id, f.parent_id]),
  [[1, null], [9, null], [2, 1], [3, 2], [5, null], [6, 5]]);
console.log("transfer ok");
