import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { Council } from "../src/agents/council.js";
import { FixtureProvider, loadFixture } from "../src/agents/providers.js";
import type { Proposal } from "../src/agents/types.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");

async function deliberate(scenario: string) {
  const fixture = await loadFixture(FIXTURES, scenario);
  const proposal: Proposal = { requestId: `test-${scenario}`, ...fixture.proposal };
  const council = new Council(new FixtureProvider(FIXTURES, scenario), {
    now: () => new Date("2026-06-10T12:00:00Z"),
  });
  return council.deliberate(proposal);
}

describe("council demo scenarios", () => {
  it("APPROVEs the de-risking rotation at full size", async () => {
    const d = await deliberate("approve");
    expect(d.verdict).toBe("APPROVE");
    expect(d.gate.executionFraction).toBe(1);
    expect(d.executionTarget).toEqual({ CSPR: 0.3, mUSDY: 0.5, mLP: 0.2 });
    // The audit chain is intact: 4 messages, hashed evidence + deliberation.
    expect(d.messages.map((m) => m.agent)).toEqual(["oracle", "risk", "calibration", "reviewer"]);
    expect(d.evidence.packetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.deliberationSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("upholds an ABSTAIN on conflicting evidence", async () => {
    const d = await deliberate("abstain");
    expect(d.verdict).toBe("ABSTAIN_UPHELD");
    expect(d.gate.executionFraction).toBe(0);
    expect(d.executionTarget).toBeNull();
    expect(d.calibration.conflicted).toBe(true);
  });

  it("ESCALATEs the risk-gate-breaching momentum chase", async () => {
    const d = await deliberate("escalate");
    expect(d.verdict).toBe("ESCALATE");
    expect(d.gate.executionFraction).toBe(0);
    expect(d.executionTarget).toBeNull();
    // It must be the risk gate, not low confidence, that blocks this one.
    expect(d.calibration.abstain).toBe(false);
    expect(d.gate.findings.join(" ")).toMatch(/breach/);
  });

  it("produces identical hashes for identical inputs (auditability)", async () => {
    const a = await deliberate("approve");
    const b = await deliberate("approve");
    expect(a.evidence.packetSha256).toBe(b.evidence.packetSha256);
    expect(a.deliberationSha256).toBe(b.deliberationSha256);
  });
});
