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
    pub stake_reward_count: u32,
    pub stake_reward_per_winner: u64,
    pub stake_winner_count: u32,
    pub difficulty: u32,
    pub created_at: i64,
    pub stake_high: u64,
    pub stake_low: u64,
    pub avg_participant_stake: u64,
    pub free_reward_count: u32,
    pub free_reward_per_winner: u64,
    pub free_winner_count: u32,
    pub _padding: [u8; 48],
}
