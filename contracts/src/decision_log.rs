//! DecisionLog — the on-chain audit trail of the Quorum council.
//!
//! Every off-chain deliberation is recorded here exactly once, keyed by
//! request id, with the hashes of the evidence packet and the full
//! deliberation, the verdict, and the execution fraction. The Treasury
//! contract refuses to move funds for anything not recorded here as
//! APPROVE or TRIM — separation of duties enforced on-chain.

use odra::prelude::*;

/// Verdict encoding shared with the off-chain orchestrator.
pub const VERDICT_APPROVE: u8 = 0;
pub const VERDICT_TRIM: u8 = 1;
pub const VERDICT_ESCALATE: u8 = 2;
pub const VERDICT_ABSTAIN_UPHELD: u8 = 3;

#[odra::odra_error]
pub enum Error {
    NotCouncil = 1,
    NotTreasury = 2,
    DecisionAlreadyRecorded = 3,
    DecisionNotFound = 4,
    InvalidVerdict = 5,
    InvalidFraction = 6,
    AlreadyExecuted = 7,
    NotExecutable = 8,
    TreasuryAlreadySet = 9,
}

#[odra::odra_type]
pub struct Decision {
    pub request_id: String,
    pub verdict: u8,
    /// sha256 (hex) of the Oracle's evidence packet.
    pub evidence_hash: String,
    /// sha256 (hex) of the full deliberation record.
    pub deliberation_hash: String,
    /// Fraction of the proposed move to execute, in basis points (0..=10000).
    pub execution_fraction_bps: u32,
    /// Block time (ms) when the decision was recorded.
    pub recorded_at: u64,
    /// Set once the Treasury has executed the reallocation.
    pub executed: bool,
}

#[odra::event]
pub struct DecisionRecorded {
    pub request_id: String,
    pub verdict: u8,
    pub evidence_hash: String,
    pub deliberation_hash: String,
    pub execution_fraction_bps: u32,
    pub recorded_by: Address,
    pub recorded_at: u64,
}

#[odra::event]
pub struct DecisionExecuted {
    pub request_id: String,
    pub executed_by: Address,
    pub executed_at: u64,
}

#[odra::module(events = [DecisionRecorded, DecisionExecuted], errors = Error)]
pub struct DecisionLog {
    council: Var<Address>,
    treasury: Var<Address>,
    decisions: Mapping<String, Decision>,
    request_ids: List<String>,
}

#[odra::module]
impl DecisionLog {
    /// Deployer becomes the council (the orchestrator's account).
    pub fn init(&mut self) {
        self.council.set(self.env().caller());
    }

    /// One-time wiring of the Treasury contract that may mark executions.
    pub fn set_treasury(&mut self, treasury: Address) {
        self.require_council();
        if self.treasury.get().is_some() {
            self.env().revert(Error::TreasuryAlreadySet);
        }
        self.treasury.set(treasury);
    }

    /// Record a council deliberation. Council-only, once per request id.
    pub fn record_decision(
        &mut self,
        request_id: String,
        verdict: u8,
        evidence_hash: String,
        deliberation_hash: String,
        execution_fraction_bps: u32,
    ) {
        self.require_council();
        if verdict > VERDICT_ABSTAIN_UPHELD {
            self.env().revert(Error::InvalidVerdict);
        }
        if execution_fraction_bps > 10_000 {
            self.env().revert(Error::InvalidFraction);
        }
        // Non-executable verdicts must carry a zero execution fraction.
        if (verdict == VERDICT_ESCALATE || verdict == VERDICT_ABSTAIN_UPHELD)
            && execution_fraction_bps != 0
        {
            self.env().revert(Error::InvalidFraction);
        }
        if self.decisions.get(&request_id).is_some() {
            self.env().revert(Error::DecisionAlreadyRecorded);
        }

        let recorded_at = self.env().get_block_time();
        let decision = Decision {
            request_id: request_id.clone(),
            verdict,
            evidence_hash: evidence_hash.clone(),
            deliberation_hash: deliberation_hash.clone(),
            execution_fraction_bps,
            recorded_at,
            executed: false,
        };
        self.decisions.set(&request_id, decision);
        self.request_ids.push(request_id.clone());

        self.env().emit_event(DecisionRecorded {
            request_id,
            verdict,
            evidence_hash,
            deliberation_hash,
            execution_fraction_bps,
            recorded_by: self.env().caller(),
            recorded_at,
        });
    }

    /// Called by the Treasury after executing an approved reallocation.
    pub fn mark_executed(&mut self, request_id: String) {
        let treasury = self
            .treasury
            .get()
            .unwrap_or_revert_with(&self.env(), Error::NotTreasury);
        if self.env().caller() != treasury {
            self.env().revert(Error::NotTreasury);
        }
        let mut decision = self
            .decisions
            .get(&request_id)
            .unwrap_or_revert_with(&self.env(), Error::DecisionNotFound);
        if decision.executed {
            self.env().revert(Error::AlreadyExecuted);
        }
        if decision.verdict != VERDICT_APPROVE && decision.verdict != VERDICT_TRIM {
            self.env().revert(Error::NotExecutable);
        }
        decision.executed = true;
        self.decisions.set(&request_id, decision);

        self.env().emit_event(DecisionExecuted {
            request_id,
            executed_by: self.env().caller(),
            executed_at: self.env().get_block_time(),
        });
    }

    pub fn get_decision(&self, request_id: String) -> Option<Decision> {
        self.decisions.get(&request_id)
    }

    /// True iff the decision exists, is APPROVE/TRIM, and is not yet executed.
    pub fn is_executable(&self, request_id: String) -> bool {
        match self.decisions.get(&request_id) {
            Some(d) => {
                !d.executed && (d.verdict == VERDICT_APPROVE || d.verdict == VERDICT_TRIM)
            }
            None => false,
        }
    }

    pub fn execution_fraction_bps(&self, request_id: String) -> u32 {
        self.decisions
            .get(&request_id)
            .map(|d| d.execution_fraction_bps)
            .unwrap_or(0)
    }

    pub fn decision_count(&self) -> u32 {
        self.request_ids.len()
    }

    pub fn request_id_at(&self, index: u32) -> Option<String> {
        self.request_ids.get(index)
    }

    pub fn council(&self) -> Address {
        self.council
            .get()
            .unwrap_or_revert_with(&self.env(), Error::NotCouncil)
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
    use odra::host::{Deployer, NoArgs};

    fn record_sample(contract: &mut DecisionLogHostRef, id: &str, verdict: u8, bps: u32) {
        contract.record_decision(
            id.to_string(),
            verdict,
            "ev-hash".to_string(),
            "delib-hash".to_string(),
            bps,
        );
    }

    #[test]
    fn records_and_reads_a_decision() {
        let env = odra_test::env();
        let mut contract = DecisionLog::deploy(&env, NoArgs);
        record_sample(&mut contract, "req-1", VERDICT_APPROVE, 10_000);

        let d = contract.get_decision("req-1".to_string()).unwrap();
        assert_eq!(d.verdict, VERDICT_APPROVE);
        assert_eq!(d.execution_fraction_bps, 10_000);
        assert!(!d.executed);
        assert_eq!(contract.decision_count(), 1);
        assert!(contract.is_executable("req-1".to_string()));
        assert!(env.emitted(&contract, "DecisionRecorded"));
    }

    #[test]
    fn rejects_duplicates_and_bad_inputs() {
        let env = odra_test::env();
        let mut contract = DecisionLog::deploy(&env, NoArgs);
        record_sample(&mut contract, "req-1", VERDICT_TRIM, 5_000);

        let dup = contract.try_record_decision(
            "req-1".to_string(),
            VERDICT_APPROVE,
            "e".to_string(),
            "d".to_string(),
            10_000,
        );
        assert_eq!(dup.unwrap_err(), Error::DecisionAlreadyRecorded.into());

        let bad_verdict = contract.try_record_decision(
            "req-2".to_string(),
            9,
            "e".to_string(),
            "d".to_string(),
            0,
        );
        assert_eq!(bad_verdict.unwrap_err(), Error::InvalidVerdict.into());

        // ESCALATE may not carry an execution fraction.
        let bad_fraction = contract.try_record_decision(
            "req-3".to_string(),
            VERDICT_ESCALATE,
            "e".to_string(),
            "d".to_string(),
            1,
        );
        assert_eq!(bad_fraction.unwrap_err(), Error::InvalidFraction.into());
    }

    #[test]
    fn only_council_records() {
        let env = odra_test::env();
        let mut contract = DecisionLog::deploy(&env, NoArgs);
        env.set_caller(env.get_account(1));
        let res = contract.try_record_decision(
            "req-1".to_string(),
            VERDICT_APPROVE,
            "e".to_string(),
            "d".to_string(),
            10_000,
        );
        assert_eq!(res.unwrap_err(), Error::NotCouncil.into());
    }

    #[test]
    fn escalate_and_abstain_are_not_executable() {
        let env = odra_test::env();
        let mut contract = DecisionLog::deploy(&env, NoArgs);
        record_sample(&mut contract, "esc", VERDICT_ESCALATE, 0);
        record_sample(&mut contract, "abs", VERDICT_ABSTAIN_UPHELD, 0);
        assert!(!contract.is_executable("esc".to_string()));
        assert!(!contract.is_executable("abs".to_string()));
        assert!(!contract.is_executable("missing".to_string()));
    }

    #[test]
    fn mark_executed_requires_treasury() {
        let env = odra_test::env();
        let mut contract = DecisionLog::deploy(&env, NoArgs);
        record_sample(&mut contract, "req-1", VERDICT_APPROVE, 10_000);

        // No treasury wired yet.
        let res = contract.try_mark_executed("req-1".to_string());
        assert_eq!(res.unwrap_err(), Error::NotTreasury.into());

        // Wire account(2) as a stand-in "treasury" and execute from it.
        let treasury = env.get_account(2);
        contract.set_treasury(treasury);
        env.set_caller(treasury);
        contract.mark_executed("req-1".to_string());
        assert!(contract.get_decision("req-1".to_string()).unwrap().executed);
        assert!(!contract.is_executable("req-1".to_string()));
        assert!(env.emitted(&contract, "DecisionExecuted"));

        // Cannot execute twice.
        let twice = contract.try_mark_executed("req-1".to_string());
        assert_eq!(twice.unwrap_err(), Error::AlreadyExecuted.into());
    }
}
