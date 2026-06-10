/**
 * x402 buyer client: the Oracle agent uses this to pay per data request.
 *
 * Flow (x402 v2 over HTTP):
 *   1. GET the resource → server replies 402 with payment requirements.
 *   2. Build a transfer authorization, sign it, base64-encode the payment
 *      payload into the PAYMENT-SIGNATURE header, retry the request.
 *   3. Server verifies/settles (via the CSPR.cloud facilitator, or locally in
 *      mock mode for offline demos) and returns the resource + a receipt.
 *
 * Signing note: the production Casper x402 stack authorizes CEP-18
 * `transfer_with_authorization` with EIP-712 typed-data signatures. This
 * TypeScript client signs ed25519 over the sha256 of the canonical
 * authorization JSON — the same payload shape, verified by our merchant in
 * local-mock mode. Facilitator-settled payments use the same wire format.
 */

import { randomBytes } from "node:crypto";

import { canonicalJson, sha256Hex } from "../agents/hash.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  TransferAuthorization,
  X402Receipt,
} from "./types.js";

export interface PaymentSigner {
  /** Account hash (hex) of the paying agent. */
  accountHash: string;
  /** Algorithm-prefixed public key hex. */
  publicKeyHex: string;
  /** Sign a 32-byte digest, return signature hex. */
  sign(digestHex: string): Promise<string>;
}

export function authorizationDigest(auth: TransferAuthorization): string {
  return sha256Hex(canonicalJson(auth));
}

export async function buildPaymentPayload(
  req: PaymentRequirements,
  signer: PaymentSigner,
  now: () => Date = () => new Date(),
): Promise<PaymentPayload> {
  const nowSec = Math.floor(now().getTime() / 1000);
  const authorization: TransferAuthorization = {
    from: signer.accountHash,
    to: req.payTo,
    value: req.amount,
    validAfter: String(nowSec - 60),
    validBefore: String(nowSec + 600),
    nonce: randomBytes(32).toString("hex"),
  };
  const signature = await signer.sign(authorizationDigest(authorization));
  return {
    x402Version: 2,
    scheme: "exact",
    network: req.network,
    payload: { signature, publicKey: signer.publicKeyHex, authorization },
  };
}

export interface PaidResponse<T> {
  data: T;
  receipt: X402Receipt | null;
}

/** Fetch a resource, transparently paying a 402 challenge if one comes back. */
export async function fetchWithX402<T>(
  url: string,
  signer: PaymentSigner,
  fetchImpl: typeof fetch = fetch,
): Promise<PaidResponse<T>> {
  const first = await fetchImpl(url);
  if (first.status !== 402) {
    if (!first.ok) throw new Error(`x402 fetch failed: ${first.status} ${url}`);
    return { data: (await first.json()) as T, receipt: null };
  }

  const challenge = (await first.json()) as { accepts: PaymentRequirements[] };
  const req = challenge.accepts?.[0];
  if (!req) throw new Error(`402 from ${url} without payment requirements`);

  const payload = await buildPaymentPayload(req, signer);
  const second = await fetchImpl(url, {
    headers: {
      "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64"),
    },
  });
  if (!second.ok) {
    throw new Error(`x402 payment rejected: ${second.status} ${await second.text()}`);
  }
  const receiptHeader = second.headers.get("PAYMENT-RECEIPT");
  const receipt = receiptHeader
    ? (JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8")) as X402Receipt)
    : null;
  return { data: (await second.json()) as T, receipt };
}
