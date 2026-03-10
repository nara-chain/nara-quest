use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct StakeRecord {
    pub stake_round: u64,
    pub _padding: [u8; 64],
}
