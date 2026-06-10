/**
 * Casper Testnet client: submits the council's verdict to DecisionLog and,
 * for executable verdicts, the Treasury reallocation — the two
 * transaction-producing on-chain steps of every Quorum review.
 *
 * Uses casper-js-sdk v5 (Casper 2.0 TransactionV1) and calls the Odra
 * contracts by package hash.
 */

import { readFile } from "node:fs/promises";

// casper-js-sdk is CommonJS; import the namespace and destructure so the
// named bindings resolve at runtime under Node ESM.
import casperSdk from "casper-js-sdk";
import type { Args as ArgsT, PrivateKey as PrivateKeyT, RpcClient as RpcClientT } from "casper-js-sdk";

const {
  Args,
  CLTypeString,
  CLTypeUInt32,
  CLValue,
  ContractCallBuilder,
  HttpHandler,
  KeyAlgorithm,
  PrivateKey,
  RpcClient,
} = casperSdk;

import type { Deliberation } from "../agents/types.js";
import type { Verdict } from "../risk/types.js";

export interface ChainConfig {
  nodeUrl: string; // e.g. https://node.testnet.casper.network/rpc
  chainName: string; // casper-test
  secretKeyPath: string; // PEM (ed25519)
  decisionLogPackageHash: string; // hash-... or bare 64-hex
  treasuryPackageHash: string;
  /** Motes to pay per contract call. */
  paymentMotes?: number;
}

export interface TxResult {
  kind: "record_decision" | "reallocate";
  txHash: string;
  explorerUrl: string;
}

const VERDICT_CODE: Record<Verdict, number> = {
  APPROVE: 0,
  TRIM: 1,
  ESCALATE: 2,
  ABSTAIN_UPHELD: 3,
};

export function verdictCode(verdict: Verdict): number {
  return VERDICT_CODE[verdict];
}

/** Convert target weights into the contract's parallel bps arrays (sum = 10000 exactly). */
export function toBpsAllocation(target: Record<string, number>): {
  sleeveIds: string[];
  weightsBps: number[];
} {
  const sleeveIds = Object.keys(target).sort();
  const raw = sleeveIds.map((id) => target[id]! * 10_000);
  const floored = raw.map(Math.floor);
  // Distribute rounding remainder to the largest fractional parts so the sum
  // is exactly 10000 (the Treasury contract enforces this).
  let remainder = 10_000 - floored.reduce((a, b) => a + b, 0);
  const byFraction = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of byFraction) {
    if (remainder <= 0) break;
    floored[i]! += 1;
    remainder -= 1;
  }
  return { sleeveIds, weightsBps: floored };
}

function stripHashPrefix(hash: string): string {
  return hash.replace(/^(hash-|contract-package-wasm|contract-package-)/, "");
}

export class QuorumChainClient {
  private constructor(
    private readonly rpc: RpcClientT,
    private readonly key: PrivateKeyT,
    private readonly cfg: ChainConfig,
  ) {}

  static async connect(cfg: ChainConfig): Promise<QuorumChainClient> {
    const pem = await readFile(cfg.secretKeyPath, "utf8");
    const key = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
    const rpc = new RpcClient(new HttpHandler(cfg.nodeUrl));
    return new QuorumChainClient(rpc, key, cfg);
  }

  get publicKeyHex(): string {
    return this.key.publicKey.toHex();
  }

  /** Record the council's verdict in the DecisionLog (always happens). */
  async recordDecision(d: Deliberation): Promise<TxResult> {
    const args = Args.fromMap({
      request_id: CLValue.newCLString(d.proposal.requestId),
      verdict: CLValue.newCLUint8(verdictCode(d.verdict)),
      evidence_hash: CLValue.newCLString(d.evidence.packetSha256),
      deliberation_hash: CLValue.newCLString(d.deliberationSha256),
      execution_fraction_bps: CLValue.newCLUInt32(
        Math.round(d.gate.executionFraction * 10_000),
      ),
    });
    const txHash = await this.call(this.cfg.decisionLogPackageHash, "record_decision", args);
    return { kind: "record_decision", txHash, explorerUrl: explorer(txHash) };
  }

  /** Execute an APPROVE/TRIM decision through the Treasury. */
  async reallocate(d: Deliberation): Promise<TxResult> {
    if (!d.executionTarget) {
      throw new Error(`verdict ${d.verdict} is not executable`);
    }
    const { sleeveIds, weightsBps } = toBpsAllocation(d.executionTarget);
    const args = Args.fromMap({
      request_id: CLValue.newCLString(d.proposal.requestId),
      sleeve_ids: CLValue.newCLList(
        CLTypeString,
        sleeveIds.map((id) => CLValue.newCLString(id)),
      ),
      weights_bps: CLValue.newCLList(
        CLTypeUInt32,
        weightsBps.map((w) => CLValue.newCLUInt32(w)),
      ),
    });
    const txHash = await this.call(this.cfg.treasuryPackageHash, "reallocate", args);
    return { kind: "reallocate", txHash, explorerUrl: explorer(txHash) };
  }

  private async call(packageHash: string, entryPoint: string, args: ArgsT): Promise<string> {
    const tx = new ContractCallBuilder()
      .byPackageHash(stripHashPrefix(packageHash))
      .entryPoint(entryPoint)
      .runtimeArgs(args)
      .from(this.key.publicKey)
      .chainName(this.cfg.chainName)
      .payment(this.cfg.paymentMotes ?? 5_000_000_000)
      .build();
    tx.sign(this.key);
    await this.rpc.putTransaction(tx);
    const hash = tx.hash.toHex();
    await this.rpc.waitForTransaction(tx, 120_000);
    return hash;
  }
}

function explorer(txHash: string): string {
  return `https://testnet.cspr.live/transaction/${txHash}`;
}
