/**
 * Quorum deterministic risk types.
 *
 * Everything in src/risk is pure and deterministic: same inputs, same outputs,
 * no I/O, no randomness, no LLM. These are the ONLY functions allowed to
 * produce risk numbers anywhere in Quorum.
 */

/** A single treasury sleeve (asset, DeFi position, or tokenized RWA). */
export interface Sleeve {
  /** Stable identifier, e.g. "CSPR", "mockUSDY", "mockLPpool". */
  id: string;
  /** Annualized volatility as a decimal (0.55 = 55%). Must be > 0. */
  annualVol: number;
  /** Current portfolio weight as a decimal. Weights should sum to ~1. */
  currentWeight: number;
}

/** A proposed target allocation over the same sleeve ids. */
export type TargetWeights = Record<string, number>;

/** Symmetric correlation matrix keyed by sleeve order. */
export type CorrelationMatrix = number[][];

export interface RiskInputs {
  sleeves: Sleeve[];
  /** Pairwise correlations, same order as `sleeves`. */
  correlations: CorrelationMatrix;
  /** Proposed target weights keyed by sleeve id. */
  target: TargetWeights;
  /** Risk horizon for the drawdown bound, in calendar days. */
  horizonDays: number;
  /** One-sided confidence for the parametric loss bound, e.g. 0.99. */
  confidence: number;
}

/** Output of the deterministic risk engine. All numbers are decimals. */
export interface RiskReport {
  /** Fraction of total portfolio risk contributed by each sleeve (sums to 1). */
  riskShares: Record<string, number>;
  /** Herfindahl–Hirschman concentration of the target weights, in [1/n, 1]. */
  hhi: number;
  /** Annualized portfolio volatility of the target allocation. */
  portfolioVol: number;
  /**
   * Parametric (Gaussian) loss bound over the horizon at the requested
   * confidence: the loss fraction we do not expect to exceed.
   */
  drawdownBound: number;
  /** Largest single target weight and which sleeve holds it. */
  maxWeight: { id: string; weight: number };
  /** L1 turnover between current and target weights, in [0, 2]. */
  turnover: number;
}

export type Verdict = "APPROVE" | "TRIM" | "ESCALATE" | "ABSTAIN_UPHELD";

/** Hard limits the Reviewer agent enforces. Policy, not prediction. */
export interface Policy {
  /** Maximum acceptable HHI concentration of the target. */
  maxHHI: number;
  /** Maximum acceptable parametric drawdown bound over the horizon. */
  maxDrawdownBound: number;
  /** Maximum single-sleeve weight. */
  maxSingleWeight: number;
  /** Minimum calibrated confidence required to act at all. */
  minConfidence: number;
  /** Maximum L1 turnover allowed in one reallocation. */
  maxTurnover: number;
}
