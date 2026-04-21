use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct StakeRecord {
    pub stake_round: u64,
    pub free_credits: u32,
    pub user_pubkey: Pubkey,
    pub _padding: [u8; 28],
}
