use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct GameConfig {
    pub authority: Pubkey,
    pub _padding: [u8; 64],
}
