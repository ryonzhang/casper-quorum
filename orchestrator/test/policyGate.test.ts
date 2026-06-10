import { describe, expect, it } from "vitest";

import type { CalibrationResult } from "../src/risk/calibration.js";
import { DEFAULT_POLICY, applyPolicyGate } from "../src/risk/policyGate.js";
import type { RiskReport } from "../src/risk/types.js";

const healthyRisk: RiskReport = {
  riskShares: { CSPR: 0.6, mRWA: 0.1, mLP: 0.3 },
  hhi: 0.36,
  portfolioVol: 0.3,
  drawdownBound: 0.18,
  maxWeight: { id: "mRWA", weight: 0.5 },
  turnover: 0.4,
};

const confident: CalibrationResult = {
  probability: 0.78,
  confidence: 0.7,
  conflicted: false,
  recommendedSize: 1,
  abstain: false,
  abstainReasons: [],
};

describe("applyPolicyGate", () => {
  it("approves a healthy proposal at full size", () => {
    const d = applyPolicyGate(healthyRisk, confident);
    expect(d.verdict).toBe("APPROVE");
    expect(d.executionFraction).toBe(1);
  });

  it("always upholds an upstream abstain", () => {
    const d = applyPolicyGate(healthyRisk, {
      ...confident,
      abstain: true,
      recommendedSize: 0,
      abstainReasons: ["confidence 0.2 below floor 0.55"],
    });
    expect(d.verdict).toBe("ABSTAIN_UPHELD");
    expect(d.executionFraction).toBe(0);
    expect(d.findings[0]).toMatch(/upheld abstain/);
  });

  it("vetoes on its own confidence floor even if upstream acted", () => {
    const d = applyPolicyGate(healthyRisk, { ...confident, confidence: 0.5 });
    expect(d.verdict).toBe("ABSTAIN_UPHELD");
    expect(d.executionFraction).toBe(0);
  });

  it("escalates a drawdown-bound breach", () => {
    const d = applyPolicyGate({ ...healthyRisk, drawdownBound: 0.3 }, confident);
    expect(d.verdict).toBe("ESCALATE");
    expect(d.executionFraction).toBe(0);
    expect(d.findings.join(" ")).toMatch(/risk gate breached/);
  });

  it("escalates concentration breaches (weight cap and HHI)", () => {
    const w = applyPolicyGate(
      { ...healthyRisk, maxWeight: { id: "CSPR", weight: 0.7 } },
      confident,
    );
    expect(w.verdict).toBe("ESCALATE");

    const h = applyPolicyGate({ ...healthyRisk, hhi: 0.5 }, confident);
    expect(h.verdict).toBe("ESCALATE");
  });

  it("trims an over-turnover move proportionally", () => {
    const d = applyPolicyGate({ ...healthyRisk, turnover: 1.2 }, confident);
    expect(d.verdict).toBe("TRIM");
    expect(d.executionFraction).toBeCloseTo(DEFAULT_POLICY.maxTurnover / 1.2, 10);
    expect(d.findings.join(" ")).toMatch(/trimmed/);
  });

  it("approves when the Kelly budget covers the move", () => {
    // Move size = turnover/2 = 0.2 of NAV; budget 0.35 covers it fully.
    const d = applyPolicyGate(healthyRisk, { ...confident, recommendedSize: 0.35 });
    expect(d.verdict).toBe("APPROVE");
    expect(d.executionFraction).toBe(1);
  });

  it("trims to the Kelly budget when it is smaller than the move", () => {
    // Budget 0.05 of NAV vs move size 0.2 → execute a quarter of the move.
    const d = applyPolicyGate(healthyRisk, { ...confident, recommendedSize: 0.05 });
    expect(d.verdict).toBe("TRIM");
    expect(d.executionFraction).toBeCloseTo(0.25, 12);
  });

  it("takes the tighter of Kelly and turnover scaling", () => {
    // Kelly: 0.2 / (1.2/2) = 1/3; turnover cap: 0.6/1.2 = 0.5 → 1/3 wins.
    const d = applyPolicyGate(
      { ...healthyRisk, turnover: 1.2 },
      { ...confident, recommendedSize: 0.2 },
    );
    expect(d.verdict).toBe("TRIM");
    expect(d.executionFraction).toBeCloseTo(1 / 3, 12);
  });
});
