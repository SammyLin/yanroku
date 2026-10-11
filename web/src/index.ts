// Self-host entry: Cloudflare Access in front, single user. Other deployments build their own entry with createWorker (see app.ts).
import { accessIdentify, createWorker } from "./app";

export default createWorker({ identify: accessIdentify });
