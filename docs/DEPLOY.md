# Deploying Quorum to Casper Testnet

End-to-end walkthrough from zero to on-chain transactions. Time: ~20 minutes
(most of it waiting for the faucet and block inclusion).

## 0. Prerequisites

- Node.js ≥ 20 and Rust (rustup). The contracts pin `nightly-2026-01-01` via
  `rust-toolchain.toml` (auto-installed by rustup on first build).
- `cargo install cargo-odra --locked` (≥ 0.1.7)
- `wasm-opt` (binaryen) and `wasm-strip` (wabt) on PATH — release binaries:
  <https://github.com/WebAssembly/binaryen/releases>,
  <https://github.com/WebAssembly/wabt/releases>.
  On Windows, also copy `wasm-strip.exe` to `wasmstrip.exe` and make sure
  Git's `usr\bin` (for `cp`) is on PATH when running `cargo odra build`.
- `casper-client` for key generation (`cargo install casper-client`), or
  generate an ed25519 PEM any other way you prefer.

## 1. Create and fund a testnet account

```bash
casper-client keygen contracts/keys
# → contracts/keys/secret_key.pem, public_key.pem, public_key_hex
```

Fund it at the faucet: <https://testnet.cspr.live/tools/faucet>
(sign in via CSPR.click — easiest is importing the key into Casper Wallet,
then "Request tokens" → 2000 test CSPR; **one request per account, ever**).

## 2. Build the contract wasm

```bash
cd contracts
cargo test          # 13 unit/integration tests on the Odra mock VM
cargo odra build    # → wasm/DecisionLog.wasm, Treasury.wasm, AgentRegistry.wasm
```

## 3. Deploy + wire the contracts

Cross-platform (recommended; works on Windows):

```bash
cd ../orchestrator
npm install
QUORUM_SECRET_KEY_PATH=../contracts/keys/secret_key.pem npm run deploy
```

The script installs the three contracts, wires `DecisionLog.set_treasury`,
registers the four council agents, and prints:

```
QUORUM_DECISION_LOG=hash-…
QUORUM_TREASURY=hash-…
QUORUM_AGENT_REGISTRY=hash-…
```

Linux/macOS/WSL alternative via the Odra livenet backend (the
`odra-casper-livenet-env` crate does not compile on native Windows):

```bash
cd contracts
cp .env.example .env       # testnet defaults; points at keys/secret_key.pem
cargo run --bin deploy_on_livenet --features=livenet
# optional: QUORUM_FUND_MOTES=100000000000 to seed the Treasury with 100 CSPR
```

Gas notes: installs are budgeted at 350 CSPR each (override with
`QUORUM_DEPLOY_PAYMENT`, in motes), entry-point calls at 5 CSPR
(`QUORUM_CALL_PAYMENT`). A fresh 2000-CSPR faucet grant covers the full
deploy plus many demo reviews.

## 4. Configure the orchestrator

```bash
cd orchestrator
cp .env.example .env
# paste the three QUORUM_* hashes; set QUORUM_SECRET_KEY_PATH
```

## 5. Produce the proof transactions

```bash
npm run review -- --scenario approve  --x402 --chain
npm run review -- --scenario abstain  --x402 --chain
npm run review -- --scenario escalate --x402 --chain
```

The `approve` run submits **two** transactions —
`DecisionLog.record_decision` followed by `Treasury.reallocate` — and prints
`https://testnet.cspr.live/transaction/<hash>` links for both. The `abstain`
and `escalate` runs record their verdicts on-chain but move no funds (that is
the point). Copy the tx hashes into docs/CHECKLIST.md.

## 6. See it

```bash
npm run dashboard   # http://localhost:4400
```

Optional integrations:

- `--mcp` + `CSPR_CLOUD_API_KEY` (free at <https://console.cspr.build>):
  adds a live hosted-MCP read to the evidence packet.
- `X402_FACILITATOR_URL`/`X402_FACILITATOR_TOKEN`: settle the Oracle's data
  micropayments through the CSPR.cloud x402 facilitator instead of the
  offline signature-verified mock settlement.
- `--narrate` + `ANTHROPIC_API_KEY`: plain-English narration of each agent's
  structured output on the dashboard.

## Troubleshooting

- `named key "…" not found` right after an install: the transaction was
  included but global state lagged a block — rerun `npm run deploy` (installs
  are `installOrUpgrade`, re-running is safe) or wait a few seconds.
- `Out of gas` on install: raise `QUORUM_DEPLOY_PAYMENT`.
- RPC timeouts: try `QUORUM_NODE_URL=https://node.testnet.cspr.cloud/rpc`
  (needs a CSPR.cloud key as `authorization` — or just retry the public node).
