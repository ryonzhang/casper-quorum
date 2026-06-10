/**
 * Quorum deterministic calibration module.
 *
 * Turns raw evidence into a calibrated probability, a confidence score, a
 * fractional-Kelly position size, and an explicit ABSTAIN signal. Pure
 * functions only — the Calibration agent narrates these numbers, it never
 * invents them.
 */

export interface EvidenceSignal {
  /** Which source produced this signal (for the audit trail). */
  source: string;
  /** Direction: +1 favors the proposal, -1 opposes it. */
  direction: 1 | -1;
  /** Raw strength of the signal in [0, 1]. */
  strength: number;
  /** Age of the underlying data in seconds. */
  ageSeconds: number;
}

export interface CalibrationParams {
  /**
   * Shrinkage pseudo-count: how many "imaginary" neutral signals to mix in.
   * Larger = more shrinkage toward 0.5 (more humility with thin evidence).
   */
  pseudoCount: number;
  /** Data older than this is worthless for confidence purposes. */
  maxAgeSeconds: number;
  /** Kelly fraction (0.25 = quarter-Kelly). */
  kellyFraction: number;
  /** Hard cap on the recommended risk budget, as a fraction of treasury NAV. */
  maxSize: number;
  /** Confidence below this floor forces ABSTAIN. */
  confidenceFloor: number;
  /**
   * Conflict threshold: if opposing evidence carries at least this fraction
   * of total signal weight, the evidence is "conflicted" and we ABSTAIN.
   */
  conflictThreshold: number;
}

export const DEFAULT_CALIBRATION: CalibrationParams = {
  pseudoCount: 2,
  maxAgeSeconds: 6 * 3600,
  kellyFraction: 0.25,
  maxSize: 1,
  confidenceFloor: 0.55,
  conflictThreshold: 0.35,
};

export interface CalibrationResult {
  /** Calibrated probability that the proposal is beneficial, in (0, 1). */
  probability: number;
  /** Confidence in the evidence itself (freshness + volume + agreement), [0, 1]. */
  confidence: number;
  /** Whether opposing evidence exceeds the conflict threshold. */
  conflicted: boolean;
  /**
   * Fractional-Kelly risk budget: the fraction of treasury NAV worth
   * committing to this thesis, in [0, maxSize]. The policy gate converts it
   * into a fraction of the proposed move by dividing by the move's size.
   */
  recommendedSize: number;
  /** True when the agent must abstain rather than act. */
  abstain: boolean;
  /** Machine-readable reasons for an abstain (empty when acting). */
  abstainReasons: string[];
}

/** Freshness weight: linear decay from 1 (now) to 0 (maxAge or older). */
export function freshnessWeight(ageSeconds: number, maxAgeSeconds: number): number {
  if (ageSeconds < 0) throw new RangeError(`ageSeconds must be >= 0, got ${ageSeconds}`);
  if (maxAgeSeconds <= 0) throw new RangeError("maxAgeSeconds must be > 0");
  return Math.max(0, 1 - ageSeconds / maxAgeSeconds);
}

/**
 * Calibrated probability via shrinkage toward the neutral prior 0.5:
 * weighted vote of signals mixed with `pseudoCount` neutral pseudo-signals.
 * Thin or stale evidence ⇒ probability stays near 0.5 by construction.
 */
export function calibratedProbability(
  signals: EvidenceSignal[],
  params: CalibrationParams,
): number {
  let weight = 0;
  let vote = 0; // in favor: +w*strength, against: -w*strength
  for (const s of signals) {
    if (!(s.strength >= 0 && s.strength <= 1)) {
      throw new RangeError(`signal strength must be in [0,1], got ${s.strength}`);
    }
    const w = freshnessWeight(s.ageSeconds, params.maxAgeSeconds) * s.strength;
    weight += w;
    vote += s.direction * w;
  }
  // Raw favorability in [0, 1] given the evidence alone.
  const raw = weight > 0 ? 0.5 + vote / (2 * weight) : 0.5;
  // Shrink toward 0.5 by evidence weight vs pseudo-count.
  return (raw * weight + 0.5 * params.pseudoCount) / (weight + params.pseudoCount);
}

/**
 * Confidence in the evidence: effective (freshness-weighted) signal mass
 * relative to the pseudo-count, scaled by agreement. In [0, 1).
 */
export function evidenceConfidence(
  signals: EvidenceSignal[],
  params: CalibrationParams,
): number {
  let weight = 0;
  let agree = 0;
  let oppose = 0;
  for (const s of signals) {
    const w = freshnessWeight(s.ageSeconds, params.maxAgeSeconds) * s.strength;
    weight += w;
    if (s.direction === 1) agree += w;
    else oppose += w;
  }
  if (weight === 0) return 0;
  const mass = weight / (weight + params.pseudoCount); // → 1 with much evidence
  const agreement = Math.abs(agree - oppose) / weight; // 1 = unanimous, 0 = split
  // Floor agreement at a small value so volume alone never yields confidence.
  return mass * Math.max(agreement, 0);
}

/** Fraction of total signal weight that opposes the majority direction. */
export function conflictRatio(
  signals: EvidenceSignal[],
  params: CalibrationParams,
): number {
  let agree = 0;
  let oppose = 0;
  for (const s of signals) {
    const w = freshnessWeight(s.ageSeconds, params.maxAgeSeconds) * s.strength;
    if (s.direction === 1) agree += w;
    else oppose += w;
  }
  const total = agree + oppose;
  if (total === 0) return 0;
  return Math.min(agree, oppose) / total;
}

/**
 * Fractional Kelly size for a binary bet with probability `p` of success and
 * win/loss payoff ratio `b` (win b per unit risked, lose 1):
 *   f* = (p(b+1) − 1) / b, scaled by `fraction`, clipped to [0, maxSize].
 */
export function fractionalKelly(
  p: number,
  payoffRatio: number,
  fraction: number,
  maxSize: number,
): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`p must be in (0,1), got ${p}`);
  if (payoffRatio <= 0) throw new RangeError(`payoffRatio must be > 0, got ${payoffRatio}`);
  const fullKelly = (p * (payoffRatio + 1) - 1) / payoffRatio;
  return Math.min(maxSize, Math.max(0, fullKelly * fraction));
}

/** Full calibration pass: probability, confidence, size, and abstain logic. */
export function calibrate(
  signals: EvidenceSignal[],
  payoffRatio: number,
  params: CalibrationParams = DEFAULT_CALIBRATION,
): CalibrationResult {
  const probability = calibratedProbability(signals, params);
  const confidence = evidenceConfidence(signals, params);
  const conflict = conflictRatio(signals, params);
  const conflicted = conflict >= params.conflictThreshold;

  const abstainReasons: string[] = [];
  if (confidence < params.confidenceFloor) {
    abstainReasons.push(
      `confidence ${confidence.toFixed(3)} below floor ${params.confidenceFloor}`,
    );
  }
  if (conflicted) {
    abstainReasons.push(
      `conflicting evidence: ${(conflict * 100).toFixed(1)}% of signal weight opposes the majority` +
        ` (threshold ${(params.conflictThreshold * 100).toFixed(0)}%)`,
    );
  }
  const abstain = abstainReasons.length > 0;

  const recommendedSize = abstain
    ? 0
    : fractionalKelly(probability, payoffRatio, params.kellyFraction, params.maxSize);

  return { probability, confidence, conflicted, recommendedSize, abstain, abstainReasons };
}
