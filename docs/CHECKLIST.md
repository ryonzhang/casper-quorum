# Buildathon deliverables checklist

Status legend: ✅ done and verified locally · 🔲 pending the funded testnet
deploy ([DEPLOY.md](DEPLOY.md)).

## Qualification requirements (Casper Innovation Track)

- ✅ **Original code, newly developed for the buildathon** — every line in this
  repo was written for it (MIT-licensed; the calibrated-conviction methodology
  was re-implemented from scratch, no prior code imported).
- 🔲 **Working prototype deployed on Casper Testnet** — contracts compile to
  wasm and the deploy path is scripted (`npm run deploy`); needs a faucet-funded
  key to execute. Record the addresses below.
- 🔲 **Transaction-producing on-chain component** — `DecisionLog.record_decision`
  and `Treasury.reallocate` txs are submitted by
  `npm run review -- --scenario approve --x402 --chain`. Record hashes below.
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

## Proof artifacts (fill in after the funded deploy)

| Artifact | Value |
|---|---|
| Deployer account | `__________________________________` |
| DecisionLog package hash | `hash-______________________________` |
| Treasury package hash | `hash-______________________________` |
| AgentRegistry package hash | `hash-______________________________` |
| Sample `record_decision` tx | `https://testnet.cspr.live/transaction/____` |
| Sample `reallocate` tx | `https://testnet.cspr.live/transaction/____` |
| ABSTAIN run tx | `https://testnet.cspr.live/transaction/____` |
| ESCALATE run tx | `https://testnet.cspr.live/transaction/____` |
