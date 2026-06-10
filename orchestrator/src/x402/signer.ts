/**
 * Ed25519 payment signer for x402 micropayments.
 *
 * Uses node:crypto ed25519 keys. The public key is carried algo-prefixed
 * ("01" + raw hex), matching Casper's ed25519 account convention, and the
 * account hash follows Casper's blake-less demo derivation: sha256 over
 * "ed25519" || 0x00 || raw public key. (For facilitator-settled payments the
 * real Casper account hash of the funded key is used instead.)
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { sha256Hex } from "../agents/hash.js";
import type { PaymentSigner } from "./client.js";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function rawPublicKeyFromPem(publicPem: string): Buffer {
  const der = createPublicKey(publicPem).export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(SPKI_ED25519_PREFIX.length));
}

export function publicKeyToSpkiPem(raw32: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw32]),
    format: "der",
    type: "spki",
  });
}

export function accountHashFromRawKey(raw32: Buffer): string {
  return sha256Hex(Buffer.concat([Buffer.from("ed25519"), Buffer.from([0]), raw32]));
}

export class Ed25519PaymentSigner implements PaymentSigner {
  readonly accountHash: string;
  readonly publicKeyHex: string;

  private constructor(private readonly privateKey: KeyObject, raw32: Buffer) {
    this.publicKeyHex = `01${raw32.toString("hex")}`;
    this.accountHash = accountHashFromRawKey(raw32);
  }

  static generate(): Ed25519PaymentSigner {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const raw = rawPublicKeyFromPem(publicKey.export({ type: "spki", format: "pem" }).toString());
    return new Ed25519PaymentSigner(privateKey, raw);
  }

  static async fromPemFile(path: string): Promise<Ed25519PaymentSigner> {
    const pem = await readFile(path, "utf8");
    const privateKey = createPrivateKey(pem);
    const publicPem = createPublicKey(privateKey)
      .export({ type: "spki", format: "pem" })
      .toString();
    return new Ed25519PaymentSigner(privateKey, rawPublicKeyFromPem(publicPem));
  }

  /** Generate a key and persist it so the agent keeps one payment identity. */
  static async loadOrCreate(path: string): Promise<Ed25519PaymentSigner> {
    try {
      return await Ed25519PaymentSigner.fromPemFile(path);
    } catch {
      const signer = Ed25519PaymentSigner.generate();
      const pem = signer.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      await writeFile(path, pem, { mode: 0o600 });
      return signer;
    }
  }

  async sign(digestHex: string): Promise<string> {
    return edSign(null, Buffer.from(digestHex, "hex"), this.privateKey).toString("hex");
  }
}

/** Verify an x402 payment signature against its algo-prefixed public key. */
export function verifyPaymentSignature(
  digestHex: string,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  if (!publicKeyHex.startsWith("01")) return false; // ed25519 only
  const raw = Buffer.from(publicKeyHex.slice(2), "hex");
  if (raw.length !== 32) return false;
  return edVerify(
    null,
    Buffer.from(digestHex, "hex"),
    publicKeyToSpkiPem(raw),
    Buffer.from(signatureHex, "hex"),
  );
}
