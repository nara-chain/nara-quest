use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct GameConfig {
    pub authority: Pubkey,
    pub min_reward_count: u32,
    pub max_reward_count: u32,
    pub _padding: [u8; 64],
}
