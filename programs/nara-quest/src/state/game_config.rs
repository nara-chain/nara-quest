use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct GameConfig {
    pub authority: Pubkey,
    pub min_reward_count: u32,
    pub max_reward_count: u32,
    pub stake_bps_high: u64,
    pub stake_bps_low: u64,
    pub decay_ms: i64,
    pub treasury: Pubkey,
    pub quest_authority: Pubkey,
    pub min_quest_interval: i64,
    pub reward_per_share: u64,
    pub extra_reward: u64,
    pub stake_authority: Pubkey,
    pub _padding: [u8; 32],
}
