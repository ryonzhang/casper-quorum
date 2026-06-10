/**
 * Quorum dashboard server.
 *
 *   npm run dashboard   →  http://localhost:4400
 *
 * Serves the static dashboard plus:
 *   GET /api/runs     — all recorded deliberations (orchestrator/runs/*.json)
 *   GET /api/onchain  — best-effort DecisionLog event feed from CSPR.cloud
 *                       (needs CSPR_CLOUD_API_KEY + QUORUM_DECISION_LOG; the
 *                       dashboard falls back to the tx links in each run).
 */

import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv } from "./env.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RUNS = path.join(ROOT, "runs");
const DASHBOARD = path.resolve(ROOT, "..", "dashboard");

loadDotEnv(path.join(ROOT, ".env"));
const PORT = Number(process.env.QUORUM_DASHBOARD_PORT ?? 4400);

async function listRuns(): Promise<unknown[]> {
  let files: string[];
  try {
    files = (await readdir(RUNS)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const runs = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(path.join(RUNS, f), "utf8"))),
  );
  return runs.sort((a, b) =>
    String((b as { ranAt: string }).ranAt).localeCompare(String((a as { ranAt: string }).ranAt)),
  );
}

async function onchainEvents(): Promise<unknown> {
  const apiKey = process.env.CSPR_CLOUD_API_KEY;
  const contract = process.env.QUORUM_DECISION_LOG;
  if (!apiKey || !contract) {
    return { available: false, reason: "set CSPR_CLOUD_API_KEY and QUORUM_DECISION_LOG" };
  }
  const base = process.env.CSPR_CLOUD_API_URL ?? "https://api.testnet.cspr.cloud";
  const hash = contract.replace(/^hash-/, "");
  try {
    const res = await fetch(`${base}/contract-packages/${hash}/contract-events?limit=50`, {
      headers: { authorization: apiKey },
    });
    if (!res.ok) return { available: false, reason: `CSPR.cloud ${res.status}` };
    return { available: true, events: await res.json() };
  } catch (err) {
    return { available: false, reason: String(err) };
  }
}

const server = createServer(async (req, res) => {
  const json = (status: number, body: unknown) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  try {
    if (req.url === "/api/runs") return json(200, await listRuns());
    if (req.url === "/api/onchain") return json(200, await onchainEvents());
    if (req.url === "/" || req.url === "/index.html") {
      const html = await readFile(path.join(DASHBOARD, "index.html"));
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    }
    json(404, { error: "not found" });
  } catch (err) {
    json(500, { error: String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`Quorum dashboard → http://localhost:${PORT}`);
});
