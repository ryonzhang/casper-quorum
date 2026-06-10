/**
 * Deploy the Quorum contracts to Casper Testnet with casper-js-sdk v5.
 *
 *   cd contracts && cargo odra build          # produces wasm/*.wasm
 *   cd ../orchestrator
 *   QUORUM_SECRET_KEY_PATH=../contracts/keys/secret_key.pem npm run deploy
 *
 * Installs DecisionLog → Treasury(decision_log) → AgentRegistry, wires
 * DecisionLog.set_treasury, registers the four agents, and prints the
 * package hashes to paste into orchestrator/.env.
 *
 * (Cross-platform alternative to contracts/bin/deploy_on_livenet.rs, whose
 * Odra livenet backend only compiles on Unix.)
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import casperSdk from "casper-js-sdk";
import type { Args as ArgsT, PrivateKey as PrivateKeyT, RpcClient as RpcClientT } from "casper-js-sdk";

import { loadDotEnv } from "../env.js";

const {
  Args,
  CLValue,
  ContractCallBuilder,
  EntityIdentifier,
  HttpHandler,
  Key,
  KeyAlgorithm,
  PrivateKey,
  RpcClient,
  SessionBuilder,
} = casperSdk;

const HERE = path.dirname(fileURLToPath(import.meta.url)); // orchestrator/src/chain
const ROOT = path.resolve(HERE, "..", "..", ".."); // repo root
const WASM_DIR = path.join(ROOT, "contracts", "wasm");

const INSTALL_PAYMENT = Number(process.env.QUORUM_DEPLOY_PAYMENT ?? 350_000_000_000); // 350 CSPR
const CALL_PAYMENT = Number(process.env.QUORUM_CALL_PAYMENT ?? 5_000_000_000); // 5 CSPR

interface Ctx {
  rpc: RpcClientT;
  key: PrivateKeyT;
  chainName: string;
}

async function submit(ctx: Ctx, tx: ReturnType<InstanceType<typeof SessionBuilder>["build"]>) {
  tx.sign(ctx.key);
  await ctx.rpc.putTransaction(tx);
  const hash = tx.hash.toHex();
  process.stdout.write(`  tx ${hash} …`);
  await ctx.rpc.waitForTransaction(tx, 240_000);
  console.log(" included");
  return hash;
}

/** Install one Odra-built wasm; returns the tx hash. */
async function installContract(
  ctx: Ctx,
  wasmFile: string,
  packageKeyName: string,
  initArgs: Record<string, InstanceType<typeof CLValue>> = {},
): Promise<string> {
  const wasm = await readFile(path.join(WASM_DIR, wasmFile));
  // Every Odra wasm requires the four odra_cfg session args.
  const args = Args.fromMap({
    odra_cfg_package_hash_key_name: CLValue.newCLString(packageKeyName),
    odra_cfg_allow_key_override: CLValue.newCLValueBool(true),
    odra_cfg_is_upgradable: CLValue.newCLValueBool(true),
    odra_cfg_is_upgrade: CLValue.newCLValueBool(false),
    ...initArgs,
  });
  const tx = new SessionBuilder()
    .wasm(new Uint8Array(wasm))
    .installOrUpgrade()
    .runtimeArgs(args)
    .from(ctx.key.publicKey)
    .chainName(ctx.chainName)
    .payment(INSTALL_PAYMENT)
    .build();
  return submit(ctx, tx);
}

/** Find a named key (e.g. the package hash Odra stored) on our account. */
async function findNamedKey(ctx: Ctx, name: string): Promise<string> {
  const entity = await ctx.rpc.getLatestEntity(
    EntityIdentifier.fromPublicKey(ctx.key.publicKey),
  );
  const found: string[] = [];
  const walk = (node: unknown): string | null => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = walk(item);
        if (hit) return hit;
      }
      return null;
    }
    if (node && typeof node === "object") {
      const rec = node as Record<string, unknown>;
      if (typeof rec.name === "string" && typeof rec.key === "string") {
        found.push(rec.name);
        if (rec.name === name) return rec.key;
      }
      for (const v of Object.values(rec)) {
        const hit = walk(v);
        if (hit) return hit;
      }
    }
    return null;
  };
  const key = walk(entity.rawJSON);
  if (!key) {
    throw new Error(
      `named key "${name}" not found on account (saw: ${found.join(", ") || "none"})`,
    );
  }
  return key;
}

async function callEntryPoint(
  ctx: Ctx,
  packageHash: string,
  entryPoint: string,
  args: ArgsT,
): Promise<string> {
  const tx = new ContractCallBuilder()
    .byPackageHash(packageHash.replace(/^(hash-|package-)/, ""))
    .entryPoint(entryPoint)
    .runtimeArgs(args)
    .from(ctx.key.publicKey)
    .chainName(ctx.chainName)
    .payment(CALL_PAYMENT)
    .build();
  return submit(ctx, tx);
}

async function main(): Promise<void> {
  loadDotEnv(path.join(ROOT, "orchestrator", ".env"));
  const secretKeyPath = process.env.QUORUM_SECRET_KEY_PATH;
  if (!secretKeyPath) throw new Error("set QUORUM_SECRET_KEY_PATH to a funded testnet key (PEM)");
  const nodeUrl = process.env.QUORUM_NODE_URL ?? "https://node.testnet.casper.network/rpc";
  const chainName = process.env.QUORUM_CHAIN_NAME ?? "casper-test";

  const pem = await readFile(secretKeyPath, "utf8");
  const ctx: Ctx = {
    rpc: new RpcClient(new HttpHandler(nodeUrl)),
    key: PrivateKey.fromPem(pem, KeyAlgorithm.ED25519),
    chainName,
  };
  console.log(`deploying to ${chainName} via ${nodeUrl}`);
  console.log(`as ${ctx.key.publicKey.toHex()}\n`);

  console.log("1/6 installing DecisionLog…");
  await installContract(ctx, "DecisionLog.wasm", "quorum_decision_log_package_hash");
  const decisionLog = await findNamedKey(ctx, "quorum_decision_log_package_hash");
  console.log(`  DecisionLog package: ${decisionLog}`);

  console.log("2/6 installing Treasury…");
  await installContract(ctx, "Treasury.wasm", "quorum_treasury_package_hash", {
    decision_log: CLValue.newCLKey(Key.newKey(decisionLog)),
  });
  const treasury = await findNamedKey(ctx, "quorum_treasury_package_hash");
  console.log(`  Treasury package: ${treasury}`);

  console.log("3/6 installing AgentRegistry…");
  await installContract(ctx, "AgentRegistry.wasm", "quorum_agent_registry_package_hash");
  const registry = await findNamedKey(ctx, "quorum_agent_registry_package_hash");
  console.log(`  AgentRegistry package: ${registry}`);

  console.log("4/6 wiring DecisionLog.set_treasury…");
  await callEntryPoint(
    ctx,
    decisionLog,
    "set_treasury",
    Args.fromMap({ treasury: CLValue.newCLKey(Key.newKey(treasury)) }),
  );

  console.log("5/6 registering the four council agents…");
  for (const [id, role] of [
    ["oracle-1", "oracle"],
    ["risk-1", "risk"],
    ["calibration-1", "calibration"],
    ["reviewer-1", "reviewer"],
  ] as const) {
    await callEntryPoint(
      ctx,
      registry,
      "register_agent",
      Args.fromMap({
        agent_id: CLValue.newCLString(id),
        role: CLValue.newCLString(role),
      }),
    );
    console.log(`  registered ${id} (${role})`);
  }

  console.log("6/6 done. Add these to orchestrator/.env:\n");
  console.log(`QUORUM_DECISION_LOG=${decisionLog}`);
  console.log(`QUORUM_TREASURY=${treasury}`);
  console.log(`QUORUM_AGENT_REGISTRY=${registry}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
