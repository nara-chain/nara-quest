use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("EXPLAHaMHLK9p7w5jVqEVY671NkkCKSHTNhhyUrPAboZ");
// declare_id!("Quest11111111111111111111111111111111111111");

#[program]
pub mod nara_quest {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::handler_initialize(ctx)
    }

    pub fn create_question(
        ctx: Context<CreateQuestion>,
        question: String,
        answer_hash: [u8; 32],
        deadline: i64,
        reward_amount: u64,
        difficulty: u32,
    ) -> Result<()> {
        instructions::create_question::handler_create_question(ctx, question, answer_hash, deadline, reward_amount, difficulty)
    }

    pub fn submit_answer(
        ctx: Context<SubmitAnswer>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        agent: String,
        model: String,
    ) -> Result<()> {
        instructions::submit_answer::handler_submit_answer(ctx, proof_a, proof_b, proof_c, agent, model)
    }

    pub fn transfer_authority(ctx: Context<TransferAuthority>, new_authority: Pubkey) -> Result<()> {
        instructions::transfer_authority::handler_transfer_authority(ctx, new_authority)
    }

    pub fn set_reward_config(ctx: Context<SetRewardConfig>, min_reward_count: u32, max_reward_count: u32) -> Result<()> {
        instructions::set_reward_config::handler_set_reward_config(ctx, min_reward_count, max_reward_count)
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        instructions::stake::handler_stake(ctx, amount)
    }

    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        instructions::unstake::handler_unstake(ctx, amount)
    }

    pub fn set_stake_config(
        ctx: Context<SetStakeConfig>,
        bps_high: u64,
        bps_low: u64,
        decay_seconds: i64,
    ) -> Result<()> {
        instructions::set_stake_config::handler_set_stake_config(ctx, bps_high, bps_low, decay_seconds)
    }
}
