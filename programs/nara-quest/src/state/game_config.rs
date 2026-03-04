use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct GameConfig {
    pub authority: Pubkey,
    pub next_question_id: u64,
    pub _padding: [u8; 64],
}
