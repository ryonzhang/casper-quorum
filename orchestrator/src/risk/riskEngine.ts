/**
 * Quorum deterministic risk engine.
 *
 * Pure functions. No I/O, no randomness, no LLM. Every risk number that
 * appears anywhere in Quorum (agent messages, on-chain records, dashboard)
 * is produced here and only here.
 */

import {
  covarianceFromCorrelation,
  inverseNormalCdf,
  matVec,
  quadraticForm,
} from "./math.js";
import type { RiskInputs, RiskReport, Sleeve, TargetWeights } from "./types.js";

const DAYS_PER_YEAR = 365;

/** Normalize target weights into an ordered vector matching `sleeves`. */
export function targetVector(sleeves: Sleeve[], target: TargetWeights): number[] {
  const w = sleeves.map((s) => {
    const v = target[s.id];
    if (v === undefined) throw new RangeError(`target missing weight for sleeve "${s.id}"`);
    if (v < 0) throw new RangeError(`negative weight for sleeve "${s.id}": ${v}`);
    return v;
  });
  const extraneous = Object.keys(target).filter((id) => !sleeves.some((s) => s.id === id));
  if (extraneous.length > 0) {
    throw new RangeError(`target has weights for unknown sleeves: ${extraneous.join(", ")}`);
  }
  const sum = w.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-6) {
    throw new RangeError(`target weights must sum to 1, got ${sum}`);
  }
  return w;
}

/** Annualized portfolio volatility sqrt(w' Σ w). */
export function portfolioVolatility(
  weights: number[],
  vols: number[],
  corr: number[][],
): number {
  const cov = covarianceFromCorrelation(vols, corr);
  const variance = quadraticForm(weights, cov);
  // Tiny negative values can appear from float error on near-degenerate inputs.
  return Math.sqrt(Math.max(variance, 0));
}

/**
 * Volatility-weighted risk shares: fraction of total portfolio risk each
 * sleeve contributes, using marginal contribution to risk
 *   share_i = w_i * (Σ w)_i / (w' Σ w).
 * Shares sum to 1 whenever portfolio variance is positive.
 */
export function riskShares(
  weights: number[],
  vols: number[],
  corr: number[][],
): number[] {
  const cov = covarianceFromCorrelation(vols, corr);
  const variance = quadraticForm(weights, cov);
  if (variance <= 0) {
    // Zero-risk portfolio (e.g. all weight in a zero-vol sleeve): risk shares
    // are undefined; report equal shares over funded sleeves to stay total-1.
    const funded = weights.filter((w) => w > 0).length;
    return weights.map((w) => (w > 0 ? 1 / funded : 0));
  }
  const sigmaW = matVec(cov, weights);
  return weights.map((w, i) => (w * sigmaW[i]!) / variance);
}

/** Herfindahl–Hirschman Index of (normalized, absolute) weights: Σ w_i². */
export function hhi(weights: number[]): number {
  const abs = weights.map(Math.abs);
  const total = abs.reduce((a, b) => a + b, 0);
  if (total === 0) throw new RangeError("hhi of an empty allocation is undefined");
  return abs.reduce((acc, w) => acc + (w / total) ** 2, 0);
}

/**
 * Parametric drawdown bound: the loss fraction not expected to be exceeded
 * over `horizonDays` at one-sided `confidence`, under a zero-drift Gaussian:
 *   bound = z_c * σ_annual * sqrt(horizonDays / 365)
 * Deliberately drift-free — assuming zero expected return is the conservative
 * choice for a treasury risk gate. Capped at 1 (cannot lose more than all).
 */
export function parametricDrawdownBound(
  annualVol: number,
  horizonDays: number,
  confidence: number,
): number {
  if (annualVol < 0) throw new RangeError(`annualVol must be >= 0, got ${annualVol}`);
  if (horizonDays <= 0) throw new RangeError(`horizonDays must be > 0, got ${horizonDays}`);
  if (!(confidence > 0.5 && confidence < 1)) {
    throw new RangeError(`confidence must be in (0.5, 1), got ${confidence}`);
  }
  const z = inverseNormalCdf(confidence);
  return Math.min(1, z * annualVol * Math.sqrt(horizonDays / DAYS_PER_YEAR));
}

/** L1 turnover between current and target weights: Σ |target_i − current_i|. */
export function turnover(sleeves: Sleeve[], targetW: number[]): number {
  return sleeves.reduce(
    (acc, s, i) => acc + Math.abs(targetW[i]! - s.currentWeight),
    0,
  );
}

/** Run the full deterministic risk assessment for a proposed reallocation. */
export function assessRisk(inputs: RiskInputs): RiskReport {
  const { sleeves, correlations, target, horizonDays, confidence } = inputs;
  if (sleeves.length === 0) throw new RangeError("at least one sleeve required");
  for (const s of sleeves) {
    if (!(s.annualVol >= 0)) throw new RangeError(`sleeve "${s.id}" has invalid vol ${s.annualVol}`);
  }

  const w = targetVector(sleeves, target);
  const vols = sleeves.map((s) => s.annualVol);

  const pVol = portfolioVolatility(w, vols, correlations);
  const shares = riskShares(w, vols, correlations);

  let maxIdx = 0;
  w.forEach((v, i) => {
    if (v > w[maxIdx]!) maxIdx = i;
  });

  return {
    riskShares: Object.fromEntries(sleeves.map((s, i) => [s.id, shares[i]!])),
    hhi: hhi(w),
    portfolioVol: pVol,
    drawdownBound: parametricDrawdownBound(pVol, horizonDays, confidence),
    maxWeight: { id: sleeves[maxIdx]!.id, weight: w[maxIdx]! },
    turnover: turnover(sleeves, w),
  };
}
