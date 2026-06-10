/**
 * Market-data providers for the Oracle agent.
 *
 * - FixtureProvider: reads a recorded scenario from disk (offline demo mode).
 * - X402Provider:    buys the same packet from the Quorum data merchant over
 *                    HTTP, paying an x402 micropayment per request.
 * - withMcpEnrichment: decorates any provider with a live read from the
 *                    hosted Casper MCP server (testnet), adding provenance.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { EvidenceSignal } from "../risk/calibration.js";
import type { Sleeve } from "../risk/types.js";
import { hashObject } from "./hash.js";
import type { MarketDataProvider, ProviderResult } from "./oracle.js";
import type { Proposal } from "./types.js";
import { fetchWithX402, type PaymentSigner } from "../x402/client.js";

/** On-disk shape of a recorded scenario fixture. */
export interface ScenarioFixture {
  scenario: string;
  proposal: Omit<Proposal, "requestId">;
  market: { sleeves: Sleeve[]; correlations: number[][] };
  signals: EvidenceSignal[];
}

export async function loadFixture(fixtureDir: string, scenario: string): Promise<ScenarioFixture> {
  const file = path.join(fixtureDir, `${scenario}.json`);
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as ScenarioFixture;
}

export class FixtureProvider implements MarketDataProvider {
  readonly name = "fixture";

  constructor(
    private readonly fixtureDir: string,
    private readonly scenario: string,
  ) {}

  async fetchEvidence(_proposal: Proposal): Promise<ProviderResult> {
    const fixture = await loadFixture(this.fixtureDir, this.scenario);
    return {
      sources: [
        {
          name: `fixture:${this.scenario}`,
          kind: "fixture",
          payloadSha256: hashObject(fixture),
        },
      ],
      sleeves: fixture.market.sleeves,
      correlations: fixture.market.correlations,
      signals: fixture.signals,
    };
  }
}

/** Buys the scenario packet from the merchant, paying x402 per request. */
export class X402Provider implements MarketDataProvider {
  readonly name = "x402";

  constructor(
    private readonly merchantBaseUrl: string,
    private readonly scenario: string,
    private readonly signer: PaymentSigner,
  ) {}

  async fetchEvidence(_proposal: Proposal): Promise<ProviderResult> {
    const url = `${this.merchantBaseUrl}/market/${this.scenario}`;
    const { data, receipt } = await fetchWithX402<ScenarioFixture>(url, this.signer);
    const source = {
      name: `quorum-data-merchant:${this.scenario}`,
      kind: "x402" as const,
      payloadSha256: hashObject(data),
      ...(receipt ? { paymentRef: `${receipt.mode}:${receipt.settlementRef}` } : {}),
    };
    return {
      sources: [source],
      sleeves: data.market.sleeves,
      correlations: data.market.correlations,
      signals: data.signals,
    };
  }
}

/**
 * Decorate a provider with a live read from the hosted Casper MCP server.
 * The MCP payload (e.g. current network status / CSPR rate) is hashed into
 * the evidence trail as provenance; it adds no synthetic signals.
 */
export function withMcpEnrichment(
  inner: MarketDataProvider,
  mcp: { fetchSnapshot(): Promise<{ tool: string; payload: unknown } | null> },
): MarketDataProvider {
  return {
    name: `${inner.name}+mcp`,
    async fetchEvidence(proposal: Proposal): Promise<ProviderResult> {
      const base = await inner.fetchEvidence(proposal);
      const snapshot = await mcp.fetchSnapshot();
      if (!snapshot) return base;
      return {
        ...base,
        sources: [
          ...base.sources,
          {
            name: `casper-mcp:${snapshot.tool}`,
            kind: "mcp",
            payloadSha256: hashObject(snapshot.payload),
          },
        ],
      };
    },
  };
}
