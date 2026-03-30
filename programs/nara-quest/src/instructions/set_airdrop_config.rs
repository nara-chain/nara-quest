use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::QuestError;
use crate::state::*;

pub fn handler_set_airdrop_config(
    ctx: Context<SetAirdropConfig>,
    airdrop_amount: u64,
    max_airdrop_count: u32,
) -> Result<()> {
    let game_config = &mut ctx.accounts.game_config;
    game_config.airdrop_amount = airdrop_amount;
    game_config.max_airdrop_count = max_airdrop_count;

    msg!(
        "Airdrop config updated: amount={}, max_count={}",
        airdrop_amount,
        max_airdrop_count
    );
    Ok(())
}

#[derive(Accounts)]
pub struct SetAirdropConfig<'info> {
    #[account(
        mut,
        seeds = [QUEST_CONFIG_SEED],
        bump,
        constraint = authority.key() == game_config.authority @ QuestError::Unauthorized,
    )]
    pub game_config: Account<'info, GameConfig>,

    pub authority: Signer<'info>,
}
