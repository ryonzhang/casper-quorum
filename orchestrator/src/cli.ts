/**
 * Quorum CLI — run a treasury review end to end.
 *
 *   npm run review -- --scenario approve [--x402] [--mcp] [--chain] [--narrate]
 *   npm run demo                       # all three scenarios, x402 on, offline chain
 *
 * Each run writes runs/<requestId>.json (the dashboard reads these) and, with
 * --chain, submits the DecisionLog record + Treasury reallocation to Casper
 * Testnet and prints the transaction hashes.
 */

import { mkdir, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Council } from "./agents/council.js";
import { createCasperMcpClient } from "./agents/mcpClient.js";
import { createNarrator } from "./agents/narration.js";
import type { MarketDataProvider } from "./agents/oracle.js";
import {
  FixtureProvider,
  loadFixture,
  withMcpEnrichment,
  X402Provider,
} from "./agents/providers.js";
import type { Deliberation, Proposal } from "./agents/types.js";
import { QuorumChainClient, type TxResult } from "./chain/casperClient.js";
import { loadDotEnv } from "./env.js";
import { Ed25519PaymentSigner } from "./x402/signer.js";
import { DEFAULT_MERCHANT_CONFIG, startMerchant } from "./x402/merchant.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIXTURES = path.join(ROOT, "fixtures");
const RUNS = path.join(ROOT, "runs");

const SCENARIOS = ["approve", "abstain", "escalate"] as const;
type Scenario = (typeof SCENARIOS)[number];

interface CliFlags {
  scenario: Scenario;
  x402: boolean;
  mcp: boolean;
  chain: boolean;
  narrate: boolean;
}

export interface RunRecord {
  requestId: string;
  scenario: string;
  ranAt: string;
  deliberation: Deliberation;
  transactions: TxResult[];
  chainError?: string;
}

function parseFlags(argv: string[]): CliFlags {
  const get = (flag: string) => argv.includes(flag);
  const scenarioIdx = argv.indexOf("--scenario");
  const scenario = (scenarioIdx >= 0 ? argv[scenarioIdx + 1] : "approve") as Scenario;
  if (!SCENARIOS.includes(scenario)) {
    throw new Error(`--scenario must be one of: ${SCENARIOS.join(", ")}`);
  }
  return {
    scenario,
    x402: get("--x402"),
    mcp: get("--mcp"),
    chain: get("--chain"),
    narrate: get("--narrate"),
  };
}

let merchantServer: Server | null = null;

async function buildProvider(flags: CliFlags): Promise<MarketDataProvider> {
  let provider: MarketDataProvider;
  if (flags.x402) {
    const port = Number(process.env.QUORUM_MERCHANT_PORT ?? DEFAULT_MERCHANT_CONFIG.port);
    const signer = await Ed25519PaymentSigner.loadOrCreate(
      path.join(ROOT, ".quorum-payment-key.pem"),
    );
    // In-process merchant: same x402 wire protocol, zero external setup.
    merchantServer = await startMerchant({
      ...DEFAULT_MERCHANT_CONFIG,
      port,
      fixtureDir: FIXTURES,
      settle:
        process.env.X402_FACILITATOR_TOKEN && process.env.X402_FACILITATOR_URL
          ? {
              mode: "facilitator",
              baseUrl: process.env.X402_FACILITATOR_URL,
              accessToken: process.env.X402_FACILITATOR_TOKEN,
            }
          : { mode: "local-mock" },
    }).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      return null; // merchant already running from a previous scenario
    });
    provider = new X402Provider(`http://127.0.0.1:${port}`, flags.scenario, signer);
  } else {
    provider = new FixtureProvider(FIXTURES, flags.scenario);
  }

  if (flags.mcp) {
    provider = withMcpEnrichment(
      provider,
      createCasperMcpClient({
        ...(process.env.CASPER_MCP_URL ? { url: process.env.CASPER_MCP_URL } : {}),
        ...(process.env.CSPR_CLOUD_API_KEY ? { apiKey: process.env.CSPR_CLOUD_API_KEY } : {}),
      }),
    );
  }
  return provider;
}

function printDeliberation(d: Deliberation): void {
  const fmt = (n: number) => (n * 100).toFixed(1) + "%";
  console.log(`\n━━━ Quorum review ${d.proposal.requestId} ━━━`);
  console.log(`intent: ${d.proposal.intent}\n`);
  for (const m of d.messages) {
    console.log(`  [${m.agent.toUpperCase().padEnd(11)}] ${m.note}`);
  }
  console.log(`\n  verdict: ${d.verdict}  (execute ${fmt(d.gate.executionFraction)} of the move)`);
  if (d.executionTarget) {
    const parts = Object.entries(d.executionTarget).map(([id, w]) => `${id} ${fmt(w)}`);
    console.log(`  execution target: ${parts.join(", ")}`);
  }
  console.log(`  evidence sha256:     ${d.evidence.packetSha256}`);
  console.log(`  deliberation sha256: ${d.deliberationSha256}`);
}

async function submitToChain(d: Deliberation): Promise<{ txs: TxResult[]; error?: string }> {
  const required = [
    "QUORUM_SECRET_KEY_PATH",
    "QUORUM_DECISION_LOG",
    "QUORUM_TREASURY",
  ].filter((k) => !process.env[k]);
  if (required.length > 0) {
    return { txs: [], error: `--chain requires env vars: ${required.join(", ")}` };
  }
  try {
    const client = await QuorumChainClient.connect({
      nodeUrl: process.env.QUORUM_NODE_URL ?? "https://node.testnet.casper.network/rpc",
      chainName: process.env.QUORUM_CHAIN_NAME ?? "casper-test",
      secretKeyPath: process.env.QUORUM_SECRET_KEY_PATH!,
      decisionLogPackageHash: process.env.QUORUM_DECISION_LOG!,
      treasuryPackageHash: process.env.QUORUM_TREASURY!,
    });
    console.log(`\n  submitting as ${client.publicKeyHex}…`);
    const txs: TxResult[] = [];
    const rec = await client.recordDecision(d);
    console.log(`  DecisionLog.record_decision → ${rec.explorerUrl}`);
    txs.push(rec);
    if (d.executionTarget) {
      const re = await client.reallocate(d);
      console.log(`  Treasury.reallocate         → ${re.explorerUrl}`);
      txs.push(re);
    } else {
      console.log(`  verdict ${d.verdict}: no funds move (recorded on-chain only)`);
    }
    return { txs };
  } catch (err) {
    return { txs: [], error: String(err) };
  }
}

async function runReview(flags: CliFlags): Promise<RunRecord> {
  const fixture = await loadFixture(FIXTURES, flags.scenario);
  const requestId = `${flags.scenario}-${Date.now().toString(36)}`;
  const proposal: Proposal = { requestId, ...fixture.proposal };

  const provider = await buildProvider(flags);
  const narrate = flags.narrate ? createNarrator(process.env.ANTHROPIC_API_KEY) : undefined;
  const council = new Council(provider, narrate ? { narrate } : {});

  const deliberation = await council.deliberate(proposal);
  printDeliberation(deliberation);

  let transactions: TxResult[] = [];
  let chainError: string | undefined;
  if (flags.chain) {
    const res = await submitToChain(deliberation);
    transactions = res.txs;
    if (res.error) {
      chainError = res.error;
      console.error(`  chain submission failed: ${res.error}`);
    }
  }

  const record: RunRecord = {
    requestId,
    scenario: flags.scenario,
    ranAt: new Date().toISOString(),
    deliberation,
    transactions,
    ...(chainError ? { chainError } : {}),
  };
  await mkdir(RUNS, { recursive: true });
  await writeFile(path.join(RUNS, `${requestId}.json`), JSON.stringify(record, null, 2));
  return record;
}

async function main(): Promise<void> {
  loadDotEnv(path.join(ROOT, ".env"));
  const [, , command, ...rest] = process.argv;

  if (command === "review") {
    const record = await runReview(parseFlags(rest));
    if (record.chainError) process.exitCode = 1;
    merchantServer?.closeAllConnections();
    merchantServer?.close();
  } else if (command === "demo") {
    // Full demo: all three verdicts, paying x402 for every data packet.
    const chain = rest.includes("--chain");
    const mcp = rest.includes("--mcp");
    const narrate = rest.includes("--narrate");
    for (const scenario of SCENARIOS) {
      await runReview({ scenario, x402: true, mcp, chain, narrate });
    }
    console.log(`\nAll three verdicts reproduced. Run records in orchestrator/runs/.`);
    merchantServer?.closeAllConnections();
    merchantServer?.close();
  } else {
    console.log("usage: cli.ts review --scenario <approve|abstain|escalate> [--x402] [--mcp] [--chain] [--narrate]");
    console.log("       cli.ts demo [--chain] [--mcp] [--narrate]");
    process.exitCode = command ? 1 : 0;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Outbound keep-alive sockets can hold the loop open on Windows; once
    // main() is done there is nothing left to wait for. The timer is unref'd,
    // so a naturally-draining loop still exits on its own first.
    setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref();
  });
