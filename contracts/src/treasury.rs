//! Treasury — holds testnet CSPR and the sleeve allocation book.
//!
//! `reallocate` is the only way to change the allocation, and it executes
//! ONLY against a decision the DecisionLog recorded as APPROVE or TRIM and
//! has not yet been executed. The council cannot bypass its own reviewer:
//! the check happens on-chain via a cross-contract read.

use odra::casper_types::U512;
use odra::prelude::*;

use crate::decision_log::DecisionLogContractRef;

/// Allocation weights are expressed in basis points and must sum to this.
pub const TOTAL_BPS: u32 = 10_000;

#[odra::odra_error]
pub enum Error {
    NotCouncil = 1,
    DecisionNotExecutable = 2,
    MalformedAllocation = 3,
    WeightsDoNotSumToTotal = 4,
    NothingDeposited = 5,
}

#[odra::odra_type]
pub struct SleeveAllocation {
    pub sleeve_id: String,
    pub weight_bps: u32,
}

#[odra::event]
pub struct Deposited {
    pub from: Address,
    pub amount: U512,
}

#[odra::event]
pub struct Reallocated {
    pub request_id: String,
    pub sleeve_ids: Vec<String>,
    pub weights_bps: Vec<u32>,
    pub executed_at: u64,
}

#[odra::module(events = [Deposited, Reallocated], errors = Error)]
pub struct Treasury {
    council: Var<Address>,
    decision_log: External<DecisionLogContractRef>,
    allocations: Mapping<String, u32>,
    sleeve_ids: List<String>,
}

#[odra::module]
impl Treasury {
    pub fn init(&mut self, decision_log: Address) {
        self.council.set(self.env().caller());
        self.decision_log.set(decision_log);
    }

    /// Fund the treasury with testnet CSPR.
    #[odra(payable)]
    pub fn deposit(&mut self) {
        let amount = self.env().attached_value();
        if amount.is_zero() {
            self.env().revert(Error::NothingDeposited);
        }
        self.env().emit_event(Deposited {
            from: self.env().caller(),
            amount,
        });
    }

    /// Execute an approved reallocation. The decision id must exist in the
    /// DecisionLog with verdict APPROVE or TRIM and not be executed yet.
    pub fn reallocate(
        &mut self,
        request_id: String,
        sleeve_ids: Vec<String>,
        weights_bps: Vec<u32>,
    ) {
        self.require_council();

        // On-chain separation of duties: ask the DecisionLog, not the caller.
        if !self.decision_log.is_executable(request_id.clone()) {
            self.env().revert(Error::DecisionNotExecutable);
        }

        if sleeve_ids.is_empty() || sleeve_ids.len() != weights_bps.len() {
            self.env().revert(Error::MalformedAllocation);
        }
        let mut sum: u32 = 0;
        for w in &weights_bps {
            sum = sum.checked_add(*w).unwrap_or_else(|| {
                self.env().revert(Error::WeightsDoNotSumToTotal)
            });
        }
        if sum != TOTAL_BPS {
            self.env().revert(Error::WeightsDoNotSumToTotal);
        }

        for (i, id) in sleeve_ids.iter().enumerate() {
            if !self.knows_sleeve(id) {
                self.sleeve_ids.push(id.clone());
            }
            self.allocations.set(id, weights_bps[i]);
        }

        // Mark executed in the log (only this contract may do so).
        self.decision_log.mark_executed(request_id.clone());

        self.env().emit_event(Reallocated {
            request_id,
            sleeve_ids,
            weights_bps,
            executed_at: self.env().get_block_time(),
        });
    }

    pub fn allocation_bps(&self, sleeve_id: String) -> u32 {
        self.allocations.get_or_default(&sleeve_id)
    }

    pub fn allocations(&self) -> Vec<SleeveAllocation> {
        let mut out = Vec::new();
        for id in self.sleeve_ids.iter() {
            out.push(SleeveAllocation {
                weight_bps: self.allocations.get_or_default(&id),
                sleeve_id: id,
            });
        }
        out
    }

    pub fn council(&self) -> Address {
        self.council
            .get()
            .unwrap_or_revert_with(&self.env(), Error::NotCouncil)
    }

    fn knows_sleeve(&self, sleeve_id: &String) -> bool {
        for known in self.sleeve_ids.iter() {
            if &known == sleeve_id {
                return true;
            }
        }
        false
    }

    fn require_council(&self) {
        let council = self
            .council
            .get()
            .unwrap_or_revert_with(&self.env(), Error::NotCouncil);
        if self.env().caller() != council {
            self.env().revert(Error::NotCouncil);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decision_log::{
        DecisionLog, DecisionLogHostRef, VERDICT_APPROVE, VERDICT_ESCALATE,
    };
    use odra::host::{Deployer, HostEnv, HostRef, NoArgs};

    fn setup() -> (HostEnv, DecisionLogHostRef, TreasuryHostRef) {
        let env = odra_test::env();
        let mut log = DecisionLog::deploy(&env, NoArgs);
        let treasury = Treasury::deploy(
            &env,
            TreasuryInitArgs {
                decision_log: log.address(),
            },
        );
        log.set_treasury(treasury.address());
        (env, log, treasury)
    }

    fn record(log: &mut DecisionLogHostRef, id: &str, verdict: u8, bps: u32) {
        log.record_decision(
            id.to_string(),
            verdict,
            "ev".to_string(),
            "delib".to_string(),
            bps,
        );
    }

    #[test]
    fn reallocates_only_with_an_approved_decision() {
        let (env, mut log, mut treasury) = setup();

        // No decision recorded yet → refuse.
        let res = treasury.try_reallocate(
            "req-1".to_string(),
            vec!["CSPR".to_string(), "mRWA".to_string()],
            vec![6_000, 4_000],
        );
        assert_eq!(res.unwrap_err(), Error::DecisionNotExecutable.into());

        record(&mut log, "req-1", VERDICT_APPROVE, 10_000);
        treasury.reallocate(
            "req-1".to_string(),
            vec!["CSPR".to_string(), "mRWA".to_string()],
            vec![6_000, 4_000],
        );

        assert_eq!(treasury.allocation_bps("CSPR".to_string()), 6_000);
        assert_eq!(treasury.allocation_bps("mRWA".to_string()), 4_000);
        assert!(env.emitted(&treasury, "Reallocated"));
        // The log now shows the decision as executed…
        assert!(log.get_decision("req-1".to_string()).unwrap().executed);
        // …so replaying the same decision is impossible.
        let replay = treasury.try_reallocate(
            "req-1".to_string(),
            vec!["CSPR".to_string()],
            vec![10_000],
        );
        assert_eq!(replay.unwrap_err(), Error::DecisionNotExecutable.into());
    }

    #[test]
    fn refuses_escalated_decisions() {
        let (_env, mut log, mut treasury) = setup();
        record(&mut log, "esc-1", VERDICT_ESCALATE, 0);
        let res = treasury.try_reallocate(
            "esc-1".to_string(),
            vec!["CSPR".to_string()],
            vec![10_000],
        );
        assert_eq!(res.unwrap_err(), Error::DecisionNotExecutable.into());
    }

    #[test]
    fn validates_the_allocation_shape() {
        let (_env, mut log, mut treasury) = setup();
        record(&mut log, "req-1", VERDICT_APPROVE, 10_000);

        let mismatched = treasury.try_reallocate(
            "req-1".to_string(),
            vec!["CSPR".to_string()],
            vec![6_000, 4_000],
        );
        assert_eq!(mismatched.unwrap_err(), Error::MalformedAllocation.into());

        let bad_sum = treasury.try_reallocate(
            "req-1".to_string(),
            vec!["CSPR".to_string(), "mRWA".to_string()],
            vec![6_000, 3_000],
        );
        assert_eq!(bad_sum.unwrap_err(), Error::WeightsDoNotSumToTotal.into());
    }

    #[test]
    fn only_council_reallocates() {
        let (env, mut log, mut treasury) = setup();
        record(&mut log, "req-1", VERDICT_APPROVE, 10_000);
        env.set_caller(env.get_account(1));
        let res = treasury.try_reallocate(
            "req-1".to_string(),
            vec!["CSPR".to_string()],
            vec![10_000],
        );
        assert_eq!(res.unwrap_err(), Error::NotCouncil.into());
    }

    #[test]
    fn accepts_cspr_deposits() {
        let (env, _log, treasury) = setup();
        treasury.with_tokens(U512::from(500_000_000_000u64)).deposit();
        assert_eq!(env.balance_of(&treasury), U512::from(500_000_000_000u64));
        assert!(env.emitted(&treasury, "Deposited"));

        let zero = treasury.with_tokens(U512::zero()).try_deposit();
        assert_eq!(zero.unwrap_err(), Error::NothingDeposited.into());
    }
}
