use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub round: u64,
    #[max_len(200)]
    pub question: String,
    pub answer_hash: [u8; 32],
    pub deadline: i64,
    pub reward_amount: u64,
    pub reward_count: u32,
    pub reward_per_winner: u64,
    pub winner_count: u32,
    pub difficulty: u32,
    pub stake_requirement: u64,
    pub min_winner_stake: u64,
    pub _padding: [u8; 64],
}
