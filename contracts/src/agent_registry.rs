//! AgentRegistry — on-chain identities and reputation for the council agents.
//!
//! Reputation is an integer EWMA in basis points, updated from the realized
//! accuracy of past calls: rep' = rep + α·(outcome − rep), with α = 20% and
//! outcome ∈ {0, 10000}. Pure integer math, fully reproducible off-chain.

use odra::prelude::*;

/// EWMA step in basis points (2000 = 20% weight on the newest outcome).
pub const ALPHA_BPS: u64 = 2_000;
/// Starting reputation for a newly registered agent (50%).
pub const INITIAL_REPUTATION_BPS: u32 = 5_000;
const BPS: u64 = 10_000;

#[odra::odra_error]
pub enum Error {
    NotCouncil = 1,
    AgentAlreadyRegistered = 2,
    AgentNotFound = 3,
}

#[odra::odra_type]
pub struct AgentInfo {
    pub agent_id: String,
    pub role: String,
    pub reputation_bps: u32,
    pub calls: u32,
    pub correct: u32,
}

#[odra::event]
pub struct AgentRegistered {
    pub agent_id: String,
    pub role: String,
}

#[odra::event]
pub struct OutcomeRecorded {
    pub agent_id: String,
    pub correct: bool,
    pub new_reputation_bps: u32,
}

#[odra::module(events = [AgentRegistered, OutcomeRecorded], errors = Error)]
pub struct AgentRegistry {
    council: Var<Address>,
    agents: Mapping<String, AgentInfo>,
    agent_ids: List<String>,
}

#[odra::module]
impl AgentRegistry {
    pub fn init(&mut self) {
        self.council.set(self.env().caller());
    }

    pub fn register_agent(&mut self, agent_id: String, role: String) {
        self.require_council();
        if self.agents.get(&agent_id).is_some() {
            self.env().revert(Error::AgentAlreadyRegistered);
        }
        self.agents.set(
            &agent_id,
            AgentInfo {
                agent_id: agent_id.clone(),
                role: role.clone(),
                reputation_bps: INITIAL_REPUTATION_BPS,
                calls: 0,
                correct: 0,
            },
        );
        self.agent_ids.push(agent_id.clone());
        self.env().emit_event(AgentRegistered { agent_id, role });
    }

    /// Record whether an agent's past call proved correct, updating its
    /// reputation EWMA. Council-only (called when outcomes are realized).
    pub fn record_outcome(&mut self, agent_id: String, correct: bool) {
        self.require_council();
        let mut info = self
            .agents
            .get(&agent_id)
            .unwrap_or_revert_with(&self.env(), Error::AgentNotFound);

        let rep = info.reputation_bps as u64;
        let outcome: u64 = if correct { BPS } else { 0 };
        // rep' = rep + α(outcome − rep), in integer bps; α and rep ≤ 10000 so
        // the intermediate product fits comfortably in u64.
        let new_rep = (rep * (BPS - ALPHA_BPS) + outcome * ALPHA_BPS) / BPS;

        info.reputation_bps = new_rep as u32;
        info.calls += 1;
        if correct {
            info.correct += 1;
        }
        self.agents.set(&agent_id, info);

        self.env().emit_event(OutcomeRecorded {
            agent_id,
            correct,
            new_reputation_bps: new_rep as u32,
        });
    }

    pub fn get_agent(&self, agent_id: String) -> Option<AgentInfo> {
        self.agents.get(&agent_id)
    }

    pub fn reputation_bps(&self, agent_id: String) -> u32 {
        self.agents
            .get(&agent_id)
            .map(|a| a.reputation_bps)
            .unwrap_or(0)
    }

    pub fn agent_count(&self) -> u32 {
        self.agent_ids.len()
    }

    pub fn agent_id_at(&self, index: u32) -> Option<String> {
        self.agent_ids.get(index)
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

    #[test]
    fn registers_and_tracks_reputation() {
        let env = odra_test::env();
        let mut registry = AgentRegistry::deploy(&env, NoArgs);
        registry.register_agent("oracle-1".to_string(), "oracle".to_string());

        assert_eq!(registry.reputation_bps("oracle-1".to_string()), 5_000);
        assert_eq!(registry.agent_count(), 1);
        assert!(env.emitted(&registry, "AgentRegistered"));

        // Correct call: 5000 + 0.2·(10000 − 5000) = 6000
        registry.record_outcome("oracle-1".to_string(), true);
        assert_eq!(registry.reputation_bps("oracle-1".to_string()), 6_000);

        // Wrong call: 6000 + 0.2·(0 − 6000) = 4800
        registry.record_outcome("oracle-1".to_string(), false);
        assert_eq!(registry.reputation_bps("oracle-1".to_string()), 4_800);

        let info = registry.get_agent("oracle-1".to_string()).unwrap();
        assert_eq!(info.calls, 2);
        assert_eq!(info.correct, 1);
        assert!(env.emitted(&registry, "OutcomeRecorded"));
    }

    #[test]
    fn reputation_stays_in_bounds() {
        let env = odra_test::env();
        let mut registry = AgentRegistry::deploy(&env, NoArgs);
        registry.register_agent("risk-1".to_string(), "risk".to_string());
        for _ in 0..50 {
            registry.record_outcome("risk-1".to_string(), true);
        }
        let up = registry.reputation_bps("risk-1".to_string());
        assert!(up <= 10_000 && up > 9_900);
        for _ in 0..50 {
            registry.record_outcome("risk-1".to_string(), false);
        }
        let down = registry.reputation_bps("risk-1".to_string());
        assert!(down < 100);
    }

    #[test]
    fn guards_council_and_duplicates() {
        let env = odra_test::env();
        let mut registry = AgentRegistry::deploy(&env, NoArgs);
        registry.register_agent("oracle-1".to_string(), "oracle".to_string());

        let dup = registry.try_register_agent("oracle-1".to_string(), "oracle".to_string());
        assert_eq!(dup.unwrap_err(), Error::AgentAlreadyRegistered.into());

        let ghost = registry.try_record_outcome("ghost".to_string(), true);
        assert_eq!(ghost.unwrap_err(), Error::AgentNotFound.into());

        env.set_caller(env.get_account(1));
        let stranger = registry.try_register_agent("x".to_string(), "y".to_string());
        assert_eq!(stranger.unwrap_err(), Error::NotCouncil.into());
    }
}
