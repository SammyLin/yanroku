// Export / import (transfer.ts): the TRANSFER_ENABLED switch and the pure merge rules. Type-only imports: node tests import this file.
import type { Env } from "./http";

/** The whole feature is off unless the deployment sets TRANSFER_ENABLED=1 (wrangler vars / .dev.vars). */
export const transferEnabled = (env: Env) => env.TRANSFER_ENABLED === "1";
