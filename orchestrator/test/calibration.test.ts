import { describe, expect, it } from "vitest";

import {
  DEFAULT_CALIBRATION,
  calibrate,
  calibratedProbability,
  conflictRatio,
  evidenceConfidence,
  fractionalKelly,
  freshnessWeight,
  type EvidenceSignal,
} from "../src/risk/calibration.js";

const fresh = (direction: 1 | -1, strength: number): EvidenceSignal => ({
  source: "test",
  direction,
  strength,
  ageSeconds: 0,
});

describe("freshnessWeight", () => {
  it("decays linearly to zero at maxAge", () => {
    expect(freshnessWeight(0, 3600)).toBe(1);
    expect(freshnessWeight(1800, 3600)).toBeCloseTo(0.5, 12);
    expect(freshnessWeight(3600, 3600)).toBe(0);
    expect(freshnessWeight(7200, 3600)).toBe(0);
  });

  it("rejects negative age", () => {
    expect(() => freshnessWeight(-1, 3600)).toThrow(RangeError);
  });
});

describe("calibratedProbability", () => {
  it("returns the neutral prior with no evidence", () => {
    expect(calibratedProbability([], DEFAULT_CALIBRATION)).toBe(0.5);
  });

  it("shrinks thin evidence toward 0.5", () => {
    // One weak favorable signal: raw favorability = 1, but weight 0.2 vs
    // pseudo-count 2 ⇒ p = (1·0.2 + 0.5·2) / 2.2 = 0.5454…
    const p = calibratedProbability([fresh(1, 0.2)], DEFAULT_CALIBRATION);
    expect(p).toBeCloseTo((0.2 + 1) / 2.2, 10);
    expect(p).toBeLessThan(0.6);
  });

  it("approaches the raw vote with heavy evidence", () => {
    const many = Array.from({ length: 40 }, () => fresh(1, 1));
    const p = calibratedProbability(many, DEFAULT_CALIBRATION);
    expect(p).toBeGreaterThan(0.9);
    expect(p).toBeLessThan(1);
  });

  it("treats stale evidence as no evidence", () => {
    const stale: EvidenceSignal = {
      source: "old",
      direction: 1,
      strength: 1,
      ageSeconds: DEFAULT_CALIBRATION.maxAgeSeconds + 1,
    };
    expect(calibratedProbability([stale], DEFAULT_CALIBRATION)).toBe(0.5);
  });

  it("is symmetric in direction", () => {
    const up = calibratedProbability([fresh(1, 0.8)], DEFAULT_CALIBRATION);
    const down = calibratedProbability([fresh(-1, 0.8)], DEFAULT_CALIBRATION);
    expect(up + down).toBeCloseTo(1, 10);
  });
});

describe("evidenceConfidence / conflictRatio", () => {
  it("is zero with no evidence and grows with unanimous evidence", () => {
    expect(evidenceConfidence([], DEFAULT_CALIBRATION)).toBe(0);
    const thin = evidenceConfidence([fresh(1, 0.5)], DEFAULT_CALIBRATION);
    const thick = evidenceConfidence(
      Array.from({ length: 20 }, () => fresh(1, 1)),
      DEFAULT_CALIBRATION,
    );
    expect(thin).toBeGreaterThan(0);
    expect(thick).toBeGreaterThan(thin);
    expect(thick).toBeLessThan(1);
  });

  it("collapses under a 50/50 split", () => {
    const split = [fresh(1, 1), fresh(-1, 1)];
    expect(evidenceConfidence(split, DEFAULT_CALIBRATION)).toBe(0);
    expect(conflictRatio(split, DEFAULT_CALIBRATION)).toBeCloseTo(0.5, 12);
  });

  it("measures the opposing fraction", () => {
    const signals = [fresh(1, 1), fresh(1, 1), fresh(1, 1), fresh(-1, 1)];
    expect(conflictRatio(signals, DEFAULT_CALIBRATION)).toBeCloseTo(0.25, 12);
  });
});

describe("fractionalKelly", () => {
  it("computes the textbook edge", () => {
    // p=0.6, b=1 ⇒ full Kelly = 0.2; quarter Kelly = 0.05
    expect(fractionalKelly(0.6, 1, 0.25, 1)).toBeCloseTo(0.05, 12);
  });

  it("never goes negative or above the cap", () => {
    expect(fractionalKelly(0.4, 1, 0.25, 1)).toBe(0); // negative edge
    expect(fractionalKelly(0.99, 10, 1, 0.3)).toBe(0.3); // capped
  });

  it("rejects degenerate inputs", () => {
    expect(() => fractionalKelly(0, 1, 0.25, 1)).toThrow(RangeError);
    expect(() => fractionalKelly(0.6, 0, 0.25, 1)).toThrow(RangeError);
  });
});

describe("calibrate (full pass)", () => {
  it("acts on strong unanimous evidence", () => {
    const signals = Array.from({ length: 12 }, () => fresh(1, 0.9));
    const r = calibrate(signals, 1.5);
    expect(r.abstain).toBe(false);
    expect(r.probability).toBeGreaterThan(0.8);
    expect(r.confidence).toBeGreaterThan(DEFAULT_CALIBRATION.confidenceFloor);
    expect(r.recommendedSize).toBeGreaterThan(0);
    expect(r.abstainReasons).toEqual([]);
  });

  it("abstains on thin evidence with zero size", () => {
    const r = calibrate([fresh(1, 0.3)], 1.5);
    expect(r.abstain).toBe(true);
    expect(r.recommendedSize).toBe(0);
    expect(r.abstainReasons.join(" ")).toMatch(/confidence/);
  });

  it("abstains on conflicting evidence even when plentiful", () => {
    const signals = [
      ...Array.from({ length: 10 }, () => fresh(1, 1)),
      ...Array.from({ length: 8 }, () => fresh(-1, 1)),
    ];
    const r = calibrate(signals, 1.5);
    expect(r.conflicted).toBe(true);
    expect(r.abstain).toBe(true);
    expect(r.recommendedSize).toBe(0);
    expect(r.abstainReasons.join(" ")).toMatch(/conflicting/);
  });

  it("is deterministic", () => {
    const signals = [fresh(1, 0.7), fresh(-1, 0.2), fresh(1, 0.9)];
    expect(calibrate(signals, 2)).toEqual(calibrate(signals, 2));
  });
});
