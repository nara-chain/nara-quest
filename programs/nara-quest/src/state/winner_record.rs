use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct WinnerRecord {
    pub round: u64,
    pub _padding: [u8; 64],
}
