import { describe, expect, it } from "vitest";

import { inverseNormalCdf } from "../src/risk/math.js";
import {
  assessRisk,
  hhi,
  parametricDrawdownBound,
  portfolioVolatility,
  riskShares,
  targetVector,
  turnover,
} from "../src/risk/riskEngine.js";
import type { RiskInputs, Sleeve } from "../src/risk/types.js";

const identity3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const sleeves: Sleeve[] = [
  { id: "CSPR", annualVol: 0.85, currentWeight: 0.5 },
  { id: "mRWA", annualVol: 0.08, currentWeight: 0.3 },
  { id: "mLP", annualVol: 0.45, currentWeight: 0.2 },
];

describe("inverseNormalCdf", () => {
  it("matches known quantiles", () => {
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 8);
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.959964, 5);
    expect(inverseNormalCdf(0.99)).toBeCloseTo(2.326348, 5);
    expect(inverseNormalCdf(0.01)).toBeCloseTo(-2.326348, 5);
  });

  it("rejects out-of-range probabilities", () => {
    expect(() => inverseNormalCdf(0)).toThrow(RangeError);
    expect(() => inverseNormalCdf(1)).toThrow(RangeError);
  });
});

describe("hhi", () => {
  it("is 1/n for equal weights", () => {
    expect(hhi([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(0.25, 12);
  });

  it("is 1 for full concentration", () => {
    expect(hhi([1, 0, 0])).toBeCloseTo(1, 12);
  });

  it("normalizes weights that do not sum to 1", () => {
    expect(hhi([2, 2])).toBeCloseTo(0.5, 12);
  });

  it("rejects an empty allocation", () => {
    expect(() => hhi([0, 0])).toThrow(RangeError);
  });
});

describe("portfolioVolatility", () => {
  it("reduces to single-asset vol", () => {
    expect(portfolioVolatility([1], [0.3], [[1]])).toBeCloseTo(0.3, 12);
  });

  it("diversifies under zero correlation", () => {
    // Two uncorrelated 30%-vol assets at 50/50: sqrt(0.5²·0.09·2) ≈ 21.2%
    const v = portfolioVolatility([0.5, 0.5], [0.3, 0.3], [
      [1, 0],
      [0, 1],
    ]);
    expect(v).toBeCloseTo(0.3 / Math.SQRT2, 10);
  });

  it("gives no diversification at correlation 1", () => {
    const v = portfolioVolatility([0.5, 0.5], [0.2, 0.4], [
      [1, 1],
      [1, 1],
    ]);
    expect(v).toBeCloseTo(0.3, 10);
  });
});

describe("riskShares", () => {
  it("sums to 1 and weights the volatile sleeve higher", () => {
    const shares = riskShares([0.5, 0.5], [0.6, 0.1], [
      [1, 0],
      [0, 1],
    ]);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(shares[0]!).toBeGreaterThan(shares[1]!);
    // Uncorrelated: shares proportional to w²σ² → 36 : 1
    expect(shares[0]! / shares[1]!).toBeCloseTo(36, 8);
  });

  it("handles a zero-risk portfolio without NaN", () => {
    const shares = riskShares([1, 0], [0, 0.5], [
      [1, 0],
      [0, 1],
    ]);
    expect(shares[0]).toBe(1);
    expect(shares[1]).toBe(0);
  });
});

describe("parametricDrawdownBound", () => {
  it("computes z·σ·sqrt(h/365)", () => {
    const expected = 2.3263478740408408 * 0.5 * Math.sqrt(30 / 365);
    expect(parametricDrawdownBound(0.5, 30, 0.99)).toBeCloseTo(expected, 6);
  });

  it("is monotone in horizon and confidence", () => {
    const base = parametricDrawdownBound(0.5, 30, 0.95);
    expect(parametricDrawdownBound(0.5, 60, 0.95)).toBeGreaterThan(base);
    expect(parametricDrawdownBound(0.5, 30, 0.99)).toBeGreaterThan(base);
  });

  it("caps the bound at a total loss", () => {
    expect(parametricDrawdownBound(5, 365, 0.999)).toBe(1);
  });

  it("rejects nonsense inputs", () => {
    expect(() => parametricDrawdownBound(-1, 30, 0.99)).toThrow(RangeError);
    expect(() => parametricDrawdownBound(0.5, 0, 0.99)).toThrow(RangeError);
    expect(() => parametricDrawdownBound(0.5, 30, 0.4)).toThrow(RangeError);
  });
});

describe("targetVector / turnover", () => {
  it("orders weights by sleeve and validates the sum", () => {
    expect(targetVector(sleeves, { CSPR: 0.2, mRWA: 0.5, mLP: 0.3 })).toEqual([0.2, 0.5, 0.3]);
    expect(() => targetVector(sleeves, { CSPR: 0.9, mRWA: 0.5, mLP: 0.3 })).toThrow(/sum to 1/);
    expect(() => targetVector(sleeves, { CSPR: 1 } as never)).toThrow(/missing weight/);
    expect(() =>
      targetVector(sleeves, { CSPR: 0.2, mRWA: 0.5, mLP: 0.3, GHOST: 0 }),
    ).toThrow(/unknown sleeves/);
  });

  it("computes L1 turnover", () => {
    // |0.2-0.5| + |0.5-0.3| + |0.3-0.2| = 0.6
    expect(turnover(sleeves, [0.2, 0.5, 0.3])).toBeCloseTo(0.6, 12);
    expect(turnover(sleeves, [0.5, 0.3, 0.2])).toBe(0);
  });
});

describe("assessRisk (end to end)", () => {
  const inputs: RiskInputs = {
    sleeves,
    correlations: identity3,
    target: { CSPR: 0.3, mRWA: 0.5, mLP: 0.2 },
    horizonDays: 30,
    confidence: 0.99,
  };

  it("produces a coherent report", () => {
    const r = assessRisk(inputs);
    const shareSum = Object.values(r.riskShares).reduce((a, b) => a + b, 0);
    expect(shareSum).toBeCloseTo(1, 10);
    expect(r.hhi).toBeGreaterThan(1 / 3);
    expect(r.hhi).toBeLessThan(1);
    expect(r.maxWeight).toEqual({ id: "mRWA", weight: 0.5 });
    expect(r.turnover).toBeCloseTo(0.4, 12);
    expect(r.drawdownBound).toBeGreaterThan(0);
    expect(r.drawdownBound).toBeLessThan(1);
    // CSPR (85% vol at 30% weight) must dominate risk over mRWA (8% vol at 50%).
    expect(r.riskShares["CSPR"]!).toBeGreaterThan(r.riskShares["mRWA"]!);
  });

  it("is deterministic", () => {
    expect(assessRisk(inputs)).toEqual(assessRisk(inputs));
  });
});
