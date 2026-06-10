/** Tiny .env loader (no dependency): KEY=VALUE lines, # comments. */
import { readFileSync } from "node:fs";

export function loadDotEnv(path = ".env"): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    const [, key, value] = m;
    if (process.env[key!] === undefined) {
      process.env[key!] = value!.replace(/^["']|["']$/g, "");
    }
  }
}
