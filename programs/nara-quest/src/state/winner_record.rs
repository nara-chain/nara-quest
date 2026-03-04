use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct WinnerRecord {
    pub round: u64,
    pub rewarded: bool,
    pub _padding: [u8; 64],
}
