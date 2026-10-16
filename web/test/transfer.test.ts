// node test/transfer.test.ts — export / import: the TRANSFER_ENABLED switch and the pure merge helpers (transfer-merge.ts).
import assert from "node:assert/strict";
import { transferEnabled } from "../src/transfer-merge.ts";

assert.equal(transferEnabled({ TRANSFER_ENABLED: "1" } as any), true);
for (const v of [undefined, "", "0", "true", "yes"]) assert.equal(transferEnabled({ TRANSFER_ENABLED: v } as any), false);
console.log("transfer ok");
