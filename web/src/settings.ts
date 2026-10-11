// Settings: key → JSON value in D1; a missing row = the default. Pure apart from get/put (node test imports it).
import type { Env } from "./http";

export const STT_LANGS = ["zh", "en", "ja", "auto"];

export const DEFAULTS = {
  about: "", // empty = left out of the summary prompt; the iOS intro and 設定 fill it
  content_focus: "標出重點與最終結論；整理待辦事項與下一步；指出潛在風險、問題與未決事項。",
  instructions: "簡潔扼要；正式、專業的語氣；使用清楚的結構化格式。",
  stt_lang: "zh",
  cleanup: true,
  auto_label: true,
  me: null as number | null,
  vocab: [] as string[],
};
export type Settings = typeof DEFAULTS;

const len = (s: string) => [...s].length;

// Normalised patch, or an error message. `me` is only checked for shape; the caller checks the person exists.
export function parseSettings(patch: Record<string, unknown>): Partial<Settings> | string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case "about": case "content_focus": case "instructions":
        if (typeof v !== "string" || len(v.trim()) > 500) return `${k} must be a string of at most 500 characters`;
        out[k] = v.trim();
        break;
      case "stt_lang":
        if (!STT_LANGS.includes(v as string)) return `stt_lang must be one of ${STT_LANGS.join("|")}`;
        out[k] = v;
        break;
      case "cleanup": case "auto_label":
        if (typeof v !== "boolean") return `${k} must be a boolean`;
        out[k] = v;
        break;
      case "me":
        if (v !== null && !(Number.isInteger(v) && (v as number) > 0)) return "me must be a person id or null";
        out[k] = v;
        break;
      case "vocab": {
        if (!Array.isArray(v) || !v.every((w) => typeof w === "string")) return "vocab must be an array of strings";
        const words = [...new Set((v as string[]).map((w) => w.trim()).filter(Boolean))];
        if (words.some((w) => len(w) > 50)) return "vocab terms must be at most 50 characters";
        if (words.length > 200) return "vocab must have at most 200 terms";
        out[k] = words;
        break;
      }
      default:
        return `unknown setting: ${k}`;
    }
  }
  return out as Partial<Settings>;
}

export async function getSettings(env: Env, uid: number): Promise<Settings> {
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings WHERE user_id=?`).bind(uid).all<{ key: string; value: string }>();
  const s: Record<string, unknown> = { ...DEFAULTS };
  for (const r of results) if (r.key in DEFAULTS) s[r.key] = JSON.parse(r.value);
  return s as Settings;
}

export async function putSettings(env: Env, uid: number, patch: Partial<Settings>) {
  const stmts = Object.entries(patch).map(([k, v]) =>
    env.DB.prepare(`INSERT INTO settings(user_id, key, value) VALUES(?3, ?1, ?2) ON CONFLICT(user_id, key) DO UPDATE SET value=?2`).bind(k, JSON.stringify(v), uid));
  if (stmts.length) await env.DB.batch(stmts);
  return getSettings(env, uid);
}
