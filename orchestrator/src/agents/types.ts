/**
 * Shared types for the Quorum agent council.
 *
 * The council is a fixed pipeline of four agents with hard separation of
 * duties:
 *   Oracle      — gathers evidence (MCP reads, x402-paid feeds). Never scores.
 *   Risk        — runs the deterministic risk engine. Never fetches.
 *   Calibration — runs the deterministic calibration module. Never fetches.
 *   Reviewer    — applies the policy gate independently; can veto everything.
 *
 * An LLM may be used to parse the operator's intent and to narrate the
 * outcome in plain language. It is structurally incapable of injecting risk
 * numbers: every numeric field below is produced by src/risk only.
 */

import type { CalibrationResult, EvidenceSignal } from "../risk/calibration.js";
import type { GateDecision } from "../risk/policyGate.js";
import type { RiskReport, Sleeve, TargetWeights, Verdict } from "../risk/types.js";

/** A reallocation request as parsed from the operator's intent. */
export interface Proposal {
  /** Unique id; also the DecisionLog key on-chain. */
  requestId: string;
  /** Plain-language intent as given by the operator. */
  intent: string;
  /** Proposed target weights keyed by sleeve id. */
  target: TargetWeights;
  /** Risk horizon in days for the drawdown gate. */
  horizonDays: number;
  /** Estimated payoff ratio of the thesis (win per unit risked). */
  payoffRatio: number;
}

/** Where a piece of evidence came from, with payment proof when bought. */
export interface EvidenceSource {
  name: string;
  kind: "mcp" | "x402" | "fixture";
  /** sha256 of the raw payload — anchors the audit trail. */
  payloadSha256: string;
  /** Settlement reference when the data was bought via x402. */
  paymentRef?: string;
}

/** The Oracle agent's output: data + provenance, zero judgment. */
export interface EvidencePacket {
  requestId: string;
  fetchedAt: string;
  sources: EvidenceSource[];
  /** Market state: per-sleeve vols + current weights, and correlations. */
  sleeves: Sleeve[];
  correlations: number[][];
  /** Directional signals extracted mechanically from the sources. */
  signals: EvidenceSignal[];
  /** sha256 over the canonical packet body — recorded on-chain. */
  packetSha256: string;
}

/** One step of the deliberation, for the dashboard and audit trail. */
export interface AgentMessage {
  agent: "oracle" | "risk" | "calibration" | "reviewer";
  at: string;
  /** Deterministic structured output of this agent. */
  payload: EvidencePacket | RiskReport | CalibrationResult | GateDecision;
  /** Short plain-language note (template or LLM narration; never numbers-bearing). */
  note: string;
}

/** The council's complete, signed-off deliberation. */
export interface Deliberation {
  proposal: Proposal;
  messages: AgentMessage[];
  evidence: EvidencePacket;
  risk: RiskReport;
  calibration: CalibrationResult;
  gate: GateDecision;
  verdict: Verdict;
  /** Weights to actually execute (proposal scaled by executionFraction). */
  executionTarget: TargetWeights | null;
  /** sha256 over the whole deliberation — written to DecisionLog. */
  deliberationSha256: string;
}
