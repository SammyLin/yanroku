// Export / import: move an account's finished recordings, people, folders, 問問看, settings and vocab between servers
// (docs/SPEC.md "Transfer"). The browser builds and reads the zip (public/zip.js, public/transfer.js); these routes hand
// it the data and write imported rows straight to done. Every route 404s unless TRANSFER_ENABLED=1.
import type { Route } from "./app";
import { type Handler, HttpError } from "./http";
import { transferEnabled } from "./transfer-merge";

const gate = (h: Handler): Handler => (req, env, p, url, ctx, uid) => {
  if (!transferEnabled(env)) throw new HttpError(404, "not found");
  return h(req, env, p, url, ctx, uid);
};

export const transferRoutes: Route[] = [];
void gate; // used by the export / import routes
