/**
 * Quorum data merchant — a tiny paid market-data API guarded by x402.
 *
 * GET /market/:scenario without payment → 402 with payment requirements.
 * Retried with a valid PAYMENT-SIGNATURE header → 200 + data + receipt.
 *
 * Settlement modes:
 *  - "local-mock" (default): the merchant verifies the ed25519 signature on
 *    the transfer authorization itself and issues a mock settlement ref.
 *    Fully offline; used for reproducible demos and tests.
 *  - "facilitator": forwards the payment payload to the CSPR.cloud x402
 *    facilitator (/verify + /settle), which submits the CEP-18
 *    transfer_with_authorization on-chain. Requires CSPR_CLOUD_KEY and a
 *    CEP-18 asset configured.
 */

import { createServer, type Server } from "node:http";

import { hashObject } from "../agents/hash.js";
import { loadFixture } from "../agents/providers.js";
import { authorizationDigest } from "./client.js";
import { verifyPaymentSignature } from "./signer.js";
import type { PaymentPayload, PaymentRequirements, X402Receipt } from "./types.js";

export interface MerchantConfig {
  port: number;
  fixtureDir: string;
  /** Price per data request, in the asset's smallest unit. */
  priceMotes: string;
  /** CEP-18 token package hash the merchant charges in (demo token by default). */
  assetPackageHash: string;
  /** Merchant's receiving account hash. */
  payToAccountHash: string;
  network: string; // CAIP-2, e.g. "casper:casper-test"
  settle:
    | { mode: "local-mock" }
    | { mode: "facilitator"; baseUrl: string; accessToken: string };
}

export const DEFAULT_MERCHANT_CONFIG: Omit<MerchantConfig, "fixtureDir"> = {
  port: 4402,
  priceMotes: "250000000", // 0.25 token
  assetPackageHash: "0".repeat(64),
  payToAccountHash: "f".repeat(64),
  network: "casper:casper-test",
  settle: { mode: "local-mock" },
};

interface SettleOutcome {
  ok: boolean;
  receipt?: X402Receipt;
  error?: string;
}

async function settlePayment(
  cfg: MerchantConfig,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<SettleOutcome> {
  const auth = payload.payload.authorization;

  // Basic checks both modes share.
  if (payload.network !== cfg.network) return { ok: false, error: "wrong network" };
  if (auth.to !== cfg.payToAccountHash) return { ok: false, error: "wrong payee" };
  if (BigInt(auth.value) < BigInt(cfg.priceMotes)) return { ok: false, error: "underpaid" };
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(auth.validAfter) || now > Number(auth.validBefore)) {
    return { ok: false, error: "authorization expired" };
  }

  if (cfg.settle.mode === "facilitator") {
    const body = JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements });
    const headers = {
      "content-type": "application/json",
      authorization: cfg.settle.accessToken,
    };
    const verify = await fetch(`${cfg.settle.baseUrl}/verify`, { method: "POST", headers, body });
    if (!verify.ok) return { ok: false, error: `facilitator verify: ${verify.status}` };
    const settle = await fetch(`${cfg.settle.baseUrl}/settle`, { method: "POST", headers, body });
    if (!settle.ok) return { ok: false, error: `facilitator settle: ${settle.status}` };
    const result = (await settle.json()) as { transaction?: string; txHash?: string };
    return {
      ok: true,
      receipt: {
        mode: "facilitator",
        network: cfg.network,
        amount: auth.value,
        asset: requirements.asset,
        nonce: auth.nonce,
        settlementRef: result.transaction ?? result.txHash ?? "settled",
      },
    };
  }

  // local-mock: verify the ed25519 signature over the authorization digest.
  const digest = authorizationDigest(auth);
  const valid = verifyPaymentSignature(digest, payload.payload.signature, payload.payload.publicKey);
  if (!valid) return { ok: false, error: "bad signature" };
  return {
    ok: true,
    receipt: {
      mode: "local-mock",
      network: cfg.network,
      amount: auth.value,
      asset: requirements.asset,
      nonce: auth.nonce,
      settlementRef: `mock-${digest.slice(0, 24)}`,
    },
  };
}

export function startMerchant(cfg: MerchantConfig): Promise<Server> {
  const requirements = (scenario: string): PaymentRequirements => ({
    scheme: "exact",
    network: cfg.network,
    asset: cfg.assetPackageHash,
    amount: cfg.priceMotes,
    payTo: cfg.payToAccountHash,
    description: `Quorum market-data packet "${scenario}"`,
  });

  const server = createServer(async (req, res) => {
    try {
      const match = /^\/market\/([a-z0-9-]+)$/.exec(req.url ?? "");
      if (!match || req.method !== "GET") {
        res.writeHead(404).end(JSON.stringify({ error: "not found" }));
        return;
      }
      const scenario = match[1]!;

      let fixture;
      try {
        fixture = await loadFixture(cfg.fixtureDir, scenario);
      } catch {
        res.writeHead(404).end(JSON.stringify({ error: `unknown scenario "${scenario}"` }));
        return;
      }

      const paymentHeader = req.headers["payment-signature"];
      if (!paymentHeader || typeof paymentHeader !== "string") {
        res
          .writeHead(402, { "content-type": "application/json" })
          .end(JSON.stringify({ x402Version: 2, accepts: [requirements(scenario)] }));
        return;
      }

      const payload = JSON.parse(
        Buffer.from(paymentHeader, "base64").toString("utf8"),
      ) as PaymentPayload;
      const outcome = await settlePayment(cfg, payload, requirements(scenario));
      if (!outcome.ok) {
        res
          .writeHead(402, { "content-type": "application/json" })
          .end(JSON.stringify({ error: outcome.error, accepts: [requirements(scenario)] }));
        return;
      }

      res
        .writeHead(200, {
          "content-type": "application/json",
          "payment-receipt": Buffer.from(JSON.stringify(outcome.receipt)).toString("base64"),
          "x-payload-sha256": hashObject(fixture),
        })
        .end(JSON.stringify(fixture));
    } catch (err) {
      res.writeHead(500).end(JSON.stringify({ error: String(err) }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, () => resolve(server));
  });
}
