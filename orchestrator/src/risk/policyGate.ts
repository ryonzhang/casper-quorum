/**
 * Quorum policy gate — the deterministic core of the Reviewer agent.
 *
 * Independent of the Calibration agent by design: it re-checks the risk
 * report against hard policy limits and can veto anything upstream approved.
 * Separation of duties is then enforced a second time on-chain: the Treasury
 * contract only executes decisions the DecisionLog recorded as APPROVE/TRIM.
 */

import type { Policy, RiskReport, Verdict } from "./types.js";
import type { CalibrationResult } from "./calibration.js";

export const DEFAULT_POLICY: Policy = {
  maxHHI: 0.4,
  maxDrawdownBound: 0.25,
  maxSingleWeight: 0.55,
  minConfidence: 0.55,
  maxTurnover: 0.6,
};

export interface GateDecision {
  verdict: Verdict;
  /**
   * Fraction of the proposed move to execute. 1 for APPROVE, in (0, 1) for
   * TRIM, 0 for ESCALATE / ABSTAIN_UPHELD.
   */
  executionFraction: number;
  /** Machine-readable findings backing the verdict (for the audit trail). */
  findings: string[];
}

/**
 * Apply the policy gate.
 *
 * Order of precedence (most severe first):
 *  1. Upstream ABSTAIN is always upheld — the gate never overrides humility.
 *  2. Hard risk-gate breaches (drawdown bound, weight cap) ⇒ ESCALATE to humans.
 *  3. Soft breaches that scaling the move can cure (turnover, concentration
 *     when the current book is compliant) ⇒ TRIM proportionally.
 *  4. Otherwise ⇒ APPROVE at the calibrated recommended size.
 */
export function applyPolicyGate(
  risk: RiskReport,
  calibration: CalibrationResult,
  policy: Policy = DEFAULT_POLICY,
): GateDecision {
  const findings: string[] = [];

  // 1. Humility is upheld, never overridden.
  if (calibration.abstain) {
    findings.push(...calibration.abstainReasons.map((r) => `upheld abstain: ${r}`));
    return { verdict: "ABSTAIN_UPHELD", executionFraction: 0, findings };
  }
  if (calibration.confidence < policy.minConfidence) {
    findings.push(
      `reviewer floor: confidence ${calibration.confidence.toFixed(3)} < policy minimum ${policy.minConfidence}`,
    );
    return { verdict: "ABSTAIN_UPHELD", executionFraction: 0, findings };
  }

  // 2. Hard breaches: the target itself violates policy; no scaling of the
  //    move fixes a destination that is out of bounds. Humans must look.
  if (risk.drawdownBound > policy.maxDrawdownBound) {
    findings.push(
      `risk gate breached: ${(risk.drawdownBound * 100).toFixed(1)}% parametric drawdown bound` +
        ` exceeds policy maximum ${(policy.maxDrawdownBound * 100).toFixed(1)}%`,
    );
  }
  if (risk.maxWeight.weight > policy.maxSingleWeight) {
    findings.push(
      `concentration breach: ${risk.maxWeight.id} at ${(risk.maxWeight.weight * 100).toFixed(1)}%` +
        ` exceeds single-sleeve cap ${(policy.maxSingleWeight * 100).toFixed(1)}%`,
    );
  }
  if (risk.hhi > policy.maxHHI) {
    findings.push(
      `concentration breach: HHI ${risk.hhi.toFixed(3)} exceeds policy maximum ${policy.maxHHI}`,
    );
  }
  if (findings.length > 0) {
    return { verdict: "ESCALATE", executionFraction: 0, findings };
  }

  // 3. Sizing. The calibrated Kelly budget is a fraction of treasury NAV;
  //    the proposed move commits turnover/2 of NAV. Executing
  //    min(1, budget / moveSize) of the move keeps committed risk within
  //    the Kelly budget. The turnover cap then trims oversized steps.
  const moveSize = risk.turnover / 2;
  let fraction = moveSize > 0 ? Math.min(1, calibration.recommendedSize / moveSize) : 1;
  if (fraction < 1) {
    findings.push(
      `Kelly budget ${(calibration.recommendedSize * 100).toFixed(1)}% of NAV vs move size` +
        ` ${(moveSize * 100).toFixed(1)}%: executing ${(fraction * 100).toFixed(1)}% of the move`,
    );
  }
  if (risk.turnover > policy.maxTurnover) {
    const scale = policy.maxTurnover / risk.turnover;
    if (scale < fraction) {
      fraction = scale;
      findings.push(
        `trimmed: turnover ${(risk.turnover * 100).toFixed(1)}% exceeds cap` +
          ` ${(policy.maxTurnover * 100).toFixed(1)}%; scaling move to ${(scale * 100).toFixed(1)}%`,
      );
    }
  }
  if (fraction < 1) {
    return { verdict: "TRIM", executionFraction: fraction, findings };
  }

  findings.push("all policy checks passed at full size");
  return { verdict: "APPROVE", executionFraction: 1, findings };
}
