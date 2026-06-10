//! Deploy the Quorum contracts to a live Casper network (testnet).
//!
//! Usage:
//!   1. Put a funded secret key at contracts/keys/secret_key.pem
//!      (see docs/DEPLOY.md for faucet instructions).
//!   2. Copy .env.example to .env (testnet defaults are already correct).
//!   3. cargo run --bin deploy_on_livenet --features=livenet
//!
//! Prints the three contract addresses; paste them into orchestrator/.env.

use odra::casper_types::U512;
use odra::host::{Deployer, HostRef, NoArgs};
use quorum_contracts::agent_registry::AgentRegistry;
use quorum_contracts::decision_log::DecisionLog;
use quorum_contracts::treasury::{Treasury, TreasuryInitArgs};

const DEPLOY_GAS: u64 = 400_000_000_000; // 400 CSPR in motes, per contract install
const CALL_GAS: u64 = 5_000_000_000; // 5 CSPR for plain entry-point calls

fn main() {
    let env = odra_casper_livenet_env::env();
    println!("deploying as {}", env.caller().to_string());

    env.set_gas(DEPLOY_GAS);
    let mut decision_log = DecisionLog::deploy(&env, NoArgs);
    println!("DecisionLog:   {}", decision_log.address().to_string());

    env.set_gas(DEPLOY_GAS);
    let mut treasury = Treasury::deploy(
        &env,
        TreasuryInitArgs {
            decision_log: decision_log.address(),
        },
    );
    println!("Treasury:      {}", treasury.address().to_string());

    env.set_gas(DEPLOY_GAS);
    let mut registry = AgentRegistry::deploy(&env, NoArgs);
    println!("AgentRegistry: {}", registry.address().to_string());

    // Wire the treasury into the decision log (one-time).
    env.set_gas(CALL_GAS);
    decision_log.set_treasury(treasury.address());
    println!("wired: DecisionLog.set_treasury(Treasury)");

    // Register the four council agents.
    for (id, role) in [
        ("oracle-1", "oracle"),
        ("risk-1", "risk"),
        ("calibration-1", "calibration"),
        ("reviewer-1", "reviewer"),
    ] {
        env.set_gas(CALL_GAS);
        registry.register_agent(id.to_string(), role.to_string());
        println!("registered agent {id} ({role})");
    }

    // Optionally seed the treasury with testnet CSPR so the demo shows a
    // funded book: QUORUM_FUND_MOTES=100000000000 (100 CSPR) on the env.
    if let Ok(motes) = std::env::var("QUORUM_FUND_MOTES") {
        let amount: u64 = motes.parse().expect("QUORUM_FUND_MOTES must be motes (u64)");
        env.set_gas(CALL_GAS);
        treasury.with_tokens(U512::from(amount)).deposit();
        println!("deposited {amount} motes of testnet CSPR into the Treasury");
    }

    println!();
    println!("Add these to orchestrator/.env:");
    println!("QUORUM_DECISION_LOG={}", decision_log.address().to_string());
    println!("QUORUM_TREASURY={}", treasury.address().to_string());
    println!("QUORUM_AGENT_REGISTRY={}", registry.address().to_string());
}
