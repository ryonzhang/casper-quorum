# Buildathon deliverables checklist

Status legend: ✅ done and verified locally · 🔲 pending the funded testnet
deploy ([DEPLOY.md](DEPLOY.md)).

## Qualification requirements (Casper Innovation Track)

- ✅ **Original code, newly developed for the buildathon** — every line in this
  repo was written for it (MIT-licensed; the calibrated-conviction methodology
  was re-implemented from scratch, no prior code imported).
- ✅ **Working prototype deployed on Casper Testnet** — all three contracts
  live on `casper-test`; package hashes below.
- ✅ **Transaction-producing on-chain component** — `DecisionLog.record_decision`
  and `Treasury.reallocate` transactions included on testnet; hashes below.
- ✅ **Public GitHub repo with README** — architecture, setup, usage.
- 🔲 **Public demo video** — features + walkthrough.

## Technical checklist

- ✅ Four agents collaborate (Oracle → Risk → Calibration → Reviewer) with a
  typed handoff — e2e tests in `orchestrator/test/council.test.ts`.
- ✅ Deterministic risk module: vol-weighted risk shares, HHI, parametric
  drawdown bound — pure functions, 28 unit tests. The LLM never produces a
  risk number (narration is display-only).
- ✅ Calibrated probability + confidence + fractional-Kelly sizing + ABSTAIN
  below the confidence floor or on conflicting signals.
- ✅ Reviewer policy gate with veto: APPROVE / TRIM / ESCALATE / ABSTAIN_UPHELD.
- ✅ x402 micropayment works: 402 challenge → signed payment → receipt, real
  HTTP flow with signature verification (`orchestrator/test/x402.test.ts`);
  facilitator settlement wired behind env vars.
- ✅ MCP read works: hosted Casper MCP client (`--mcp`, needs free CSPR.cloud
  key); offline runs skip it gracefully.
- ✅ Contracts: DecisionLog / Treasury / AgentRegistry — 13 Odra tests, wasm
  builds; on-chain separation of duties (Treasury checks DecisionLog;
  DecisionLog.mark_executed callable only by Treasury; no replays).
- ✅ All three verdicts reproduce: `npm run demo` (APPROVE executes,
  ABSTAIN_UPHELD and ESCALATE record but move nothing).
- ✅ Dashboard renders the deliberation, evidence provenance (hashes, payment
  refs), reviewer findings, and the on-chain tx links per run.
- ✅ AgentRegistry reputation updates from realized accuracy (integer EWMA).

## Proof artifacts (Casper Testnet, chain `casper-test`)

| Artifact | Value |
|---|---|
| Deployer / council account | `016c89d0efac5e4b8afba56aa81410a334783981e0fbf77c81ae08a5e29877c726` |
| DecisionLog package hash | `hash-e45c005c6dfeb2780a1db061197791f2853d4904caefaa596b4bb05bddc0b90c` |
| Treasury package hash | `hash-6a60d5773f0a42875405327dbf6388d7d618ad5507726083434fd1f1eb71b485` |
| AgentRegistry package hash | `hash-32dfbfbf6e33629d8e41bb8de5167294d3f3dca63505eee2c1ba8315c9c85af0` |
| APPROVE `record_decision` tx | [050f90ab…](https://testnet.cspr.live/transaction/050f90abf3fc16f3302b3d41b8b1dfa96620c29e666f980e400f17d6b96f4150) |
| APPROVE `reallocate` tx | [5bfb843f…](https://testnet.cspr.live/transaction/5bfb843fe57f7f2c73cf87d73bd07084087dad28eb6fc2da302882f650ab4787) |
| ABSTAIN_UPHELD `record_decision` tx | [dd42ab51…](https://testnet.cspr.live/transaction/dd42ab51f87569b07129bafd472df9be2e5d3d1c35437a9bdd5e22a540db625f) |
| ESCALATE `record_decision` tx | [d523a9b0…](https://testnet.cspr.live/transaction/d523a9b0fbf77b300bf074475c830b965af534e27e4d21431e24165cf9723ee5) |
