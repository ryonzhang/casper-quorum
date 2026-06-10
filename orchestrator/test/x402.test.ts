import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fetchWithX402 } from "../src/x402/client.js";
import { DEFAULT_MERCHANT_CONFIG, startMerchant } from "../src/x402/merchant.js";
import { Ed25519PaymentSigner } from "../src/x402/signer.js";
import type { ScenarioFixture } from "../src/agents/providers.js";
import { toBpsAllocation } from "../src/chain/casperClient.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");
const PORT = 4499;

let server: Server;

beforeAll(async () => {
  server = await startMerchant({
    ...DEFAULT_MERCHANT_CONFIG,
    port: PORT,
    fixtureDir: FIXTURES,
  });
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

describe("x402 micropayment flow", () => {
  it("returns 402 with payment requirements when unpaid", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/market/approve`);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: { scheme: string; network: string }[] };
    expect(body.accepts[0]!.scheme).toBe("exact");
    expect(body.accepts[0]!.network).toBe("casper:casper-test");
  });

  it("pays the challenge and receives data plus a receipt", async () => {
    const signer = Ed25519PaymentSigner.generate();
    const { data, receipt } = await fetchWithX402<ScenarioFixture>(
      `http://127.0.0.1:${PORT}/market/approve`,
      signer,
    );
    expect(data.scenario).toBe("approve");
    expect(data.market.sleeves.length).toBe(3);
    expect(receipt).not.toBeNull();
    expect(receipt!.mode).toBe("local-mock");
    expect(receipt!.amount).toBe(DEFAULT_MERCHANT_CONFIG.priceMotes);
    expect(receipt!.nonce).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a tampered payment", async () => {
    const signer = Ed25519PaymentSigner.generate();
    // Sign correctly, then break the signature.
    const honest = signer.sign.bind(signer);
    signer.sign = async (digest: string) => {
      const sig = await honest(digest);
      return sig.replace(/^../, sig.startsWith("00") ? "11" : "00");
    };
    await expect(
      fetchWithX402(`http://127.0.0.1:${PORT}/market/approve`, signer),
    ).rejects.toThrow(/payment rejected/);
  });

  it("404s unknown scenarios", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/market/nonsense`);
    expect(res.status).toBe(404);
  });
});

describe("toBpsAllocation", () => {
  it("converts weights to bps summing exactly to 10000", () => {
    const { sleeveIds, weightsBps } = toBpsAllocation({ CSPR: 0.3, mUSDY: 0.5, mLP: 0.2 });
    expect(sleeveIds).toEqual(["CSPR", "mLP", "mUSDY"]);
    expect(weightsBps.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(weightsBps).toEqual([3000, 2000, 5000]);
  });

  it("absorbs rounding drift into the largest fractional parts", () => {
    const thirds = toBpsAllocation({ a: 1 / 3, b: 1 / 3, c: 1 / 3 });
    expect(thirds.weightsBps.reduce((x, y) => x + y, 0)).toBe(10_000);
    for (const w of thirds.weightsBps) expect(Math.abs(w - 3333.3)).toBeLessThan(1);
  });
});
