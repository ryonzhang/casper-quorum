/**
 * x402 micropayment types for Casper, following the payload shapes used by
 * the CSPR.cloud x402 facilitator (x402 version 2, scheme "exact",
 * CAIP-2 networks "casper:casper" / "casper:casper-test").
 */

/** What a 402 response demands. */
export interface PaymentRequirements {
  scheme: "exact";
  /** CAIP-2 chain id, e.g. "casper:casper-test". */
  network: string;
  /** CEP-18 token package hash (64 hex chars) the payment is denominated in. */
  asset: string;
  /** Amount in the token's smallest unit, as a decimal string. */
  amount: string;
  /** Recipient account hash. */
  payTo: string;
  /** Human description of what is being bought. */
  description?: string;
}

/** The transfer authorization the buyer signs. */
export interface TransferAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  /** 32-byte hex nonce, unique per payment. */
  nonce: string;
}

/** Payload sent back in the PAYMENT-SIGNATURE header (base64 JSON). */
export interface PaymentPayload {
  x402Version: 2;
  scheme: "exact";
  network: string;
  payload: {
    signature: string;
    publicKey: string;
    authorization: TransferAuthorization;
  };
}

/** Receipt the Oracle records in the evidence packet. */
export interface X402Receipt {
  /** "facilitator" = settled via the CSPR.cloud facilitator on-chain; */
  /** "local-mock" = signature verified locally, settlement simulated. */
  mode: "facilitator" | "local-mock";
  network: string;
  amount: string;
  asset: string;
  nonce: string;
  /** Settlement reference (deploy hash for facilitator mode). */
  settlementRef: string;
}
