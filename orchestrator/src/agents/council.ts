/**
 * The Quorum council: runs the fixed Oracle → Risk → Calibration → Reviewer
 * handoff and assembles the auditable deliberation record.
 *
 * The Risk and Calibration agents are thin, deliberately boring wrappers
 * around the deterministic modules — that is the whole point. The Reviewer
 * applies the policy gate independently and its verdict is final off-chain;
 * the Treasury contract re-checks it on-chain before any funds move.
 */

import { calibrate, type CalibrationResult } from "../risk/calibration.js";
import { applyPolicyGate, DEFAULT_POLICY } from "../risk/policyGate.js";
import { assessRisk } from "../risk/riskEngine.js";
import type { Policy, RiskReport, TargetWeights } from "../risk/types.js";
import { hashObject } from "./hash.js";
import type { MarketDataProvider } from "./oracle.js";
import { OracleAgent } from "./oracle.js";
import type { AgentMessage, Deliberation, EvidencePacket, Proposal } from "./types.js";

export interface CouncilOptions {
  policy?: Policy;
  /** Drawdown-bound confidence used by the Risk agent. */
  riskConfidence?: number;
  now?: () => Date;
  /** Optional narrator (LLM); receives the structured payloads, returns prose. */
  narrate?: (agent: AgentMessage["agent"], payload: unknown) => Promise<string | null>;
}

export class Council {
  private readonly oracle: OracleAgent;
  private readonly policy: Policy;
  private readonly riskConfidence: number;
  private readonly now: () => Date;
  private readonly narrate: CouncilOptions["narrate"];

  constructor(provider: MarketDataProvider, opts: CouncilOptions = {}) {
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.riskConfidence = opts.riskConfidence ?? 0.99;
    this.now = opts.now ?? (() => new Date());
    this.oracle = new OracleAgent(provider, this.now);
    this.narrate = opts.narrate;
  }

  async deliberate(proposal: Proposal): Promise<Deliberation> {
    const messages: AgentMessage[] = [];
    const log = async (
      agent: AgentMessage["agent"],
      payload: AgentMessage["payload"],
      fallbackNote: string,
    ) => {
      let note = fallbackNote;
      if (this.narrate) {
        const n = await this.narrate(agent, payload).catch(() => null);
        if (n) note = n;
      }
      messages.push({ agent, at: this.now().toISOString(), payload, note });
    };

    // 1. Oracle — evidence only.
    const evidence = await this.oracle.gather(proposal);
    await log(
      "oracle",
      evidence,
      `gathered ${evidence.sources.length} source(s), ${evidence.signals.length} signal(s); ` +
        `packet sha256 ${evidence.packetSha256.slice(0, 16)}…`,
    );

    // 2. Risk — deterministic engine, nothing else.
    const risk = assessRisk({
      sleeves: evidence.sleeves,
      correlations: evidence.correlations,
      target: proposal.target,
      horizonDays: proposal.horizonDays,
      confidence: this.riskConfidence,
    });
    await log(
      "risk",
      risk,
      `portfolio vol ${(risk.portfolioVol * 100).toFixed(1)}%, ` +
        `${proposal.horizonDays}d ${(this.riskConfidence * 100).toFixed(0)}% drawdown bound ` +
        `${(risk.drawdownBound * 100).toFixed(1)}%, HHI ${risk.hhi.toFixed(3)}, ` +
        `turnover ${(risk.turnover * 100).toFixed(0)}%`,
    );

    // 3. Calibration — deterministic probability, confidence, size, abstain.
    const calibration = calibrate(evidence.signals, proposal.payoffRatio);
    await log(
      "calibration",
      calibration,
      calibration.abstain
        ? `ABSTAIN: ${calibration.abstainReasons.join("; ")}`
        : `p=${calibration.probability.toFixed(3)}, confidence ${calibration.confidence.toFixed(3)}, ` +
            `fractional-Kelly size ${(calibration.recommendedSize * 100).toFixed(1)}%`,
    );

    // 4. Reviewer — independent policy gate with veto power.
    const gate = applyPolicyGate(risk, calibration, this.policy);
    await log("reviewer", gate, `${gate.verdict}: ${gate.findings.join("; ")}`);

    const executionTarget = buildExecutionTarget(proposal, evidence, gate.executionFraction);

    const body = {
      proposal,
      evidenceSha256: evidence.packetSha256,
      risk,
      calibration,
      gate,
    };
    return {
      proposal,
      messages,
      evidence,
      risk,
      calibration,
      gate,
      verdict: gate.verdict,
      executionTarget,
      deliberationSha256: hashObject(body),
    };
  }
}

/**
 * Scale the proposed move by the gate's execution fraction:
 * execution = current + fraction × (target − current), per sleeve.
 * Returns null when nothing is to be executed.
 */
export function buildExecutionTarget(
  proposal: Proposal,
  evidence: EvidencePacket,
  fraction: number,
): TargetWeights | null {
  if (fraction <= 0) return null;
  const out: TargetWeights = {};
  for (const sleeve of evidence.sleeves) {
    const target = proposal.target[sleeve.id] ?? 0;
    out[sleeve.id] = sleeve.currentWeight + fraction * (target - sleeve.currentWeight);
  }
  return out;
}

export type { CalibrationResult, RiskReport };
