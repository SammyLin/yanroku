// Test-only Worker entry for test/isolation.sh: X-Test-Uid: 1|2 is a user, X-Test-Runner: 1 the runner. Never imported by src/.
import { createWorker } from "../src/app";

export default createWorker({
  identify: async (req, _env, path) => {
    if (path.startsWith("/api/runner/")) return req.headers.get("X-Test-Runner") ? { runner: true } : Response.json({ detail: "unauthorized" }, { status: 401 });
    const uid = Number(req.headers.get("X-Test-Uid"));
    return uid === 1 || uid === 2 ? { uid } : Response.json({ detail: "unauthorized" }, { status: 401 });
  },
});
