/**
 * Oracle agent: gathers market evidence and packages it with provenance.
 *
 * The Oracle never invents data and never judges it. Each source payload is
 * hashed; data bought over x402 carries its payment reference. Downstream
 * agents see only the structured packet.
 */

import type { EvidenceSignal } from "../risk/calibration.js";
import type { Sleeve } from "../risk/types.js";
import { hashObject } from "./hash.js";
import type { EvidencePacket, EvidenceSource, Proposal } from "./types.js";

/** Raw findings a provider returns before packaging. */
export interface ProviderResult {
  sources: EvidenceSource[];
  sleeves: Sleeve[];
  correlations: number[][];
  signals: EvidenceSignal[];
}

/** Pluggable data backend: live (MCP + x402) or recorded fixtures. */
export interface MarketDataProvider {
  readonly name: string;
  fetchEvidence(proposal: Proposal): Promise<ProviderResult>;
}

export class OracleAgent {
  constructor(
    private readonly provider: MarketDataProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async gather(proposal: Proposal): Promise<EvidencePacket> {
    const result = await this.provider.fetchEvidence(proposal);

    if (result.sleeves.length === 0) {
      throw new Error("oracle: provider returned no sleeves");
    }
    for (const id of Object.keys(proposal.target)) {
      if (!result.sleeves.some((s) => s.id === id)) {
        throw new Error(`oracle: no market data for proposed sleeve "${id}"`);
      }
    }

    const body = {
      requestId: proposal.requestId,
      sources: result.sources,
      sleeves: result.sleeves,
      correlations: result.correlations,
      signals: result.signals,
    };
    return {
      ...body,
      fetchedAt: this.now().toISOString(),
      packetSha256: hashObject(body),
    };
  }
}
