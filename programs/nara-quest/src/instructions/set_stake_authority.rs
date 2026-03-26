use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::QuestError;
use crate::state::*;

pub fn handler_set_stake_authority(
    ctx: Context<SetStakeAuthority>,
    new_stake_authority: Pubkey,
) -> Result<()> {
    let game_config = &mut ctx.accounts.game_config;
    let old = game_config.stake_authority;
    game_config.stake_authority = new_stake_authority;

    msg!(
        "Stake authority updated from {} to {}",
        old,
        new_stake_authority
    );
    Ok(())
}

#[derive(Accounts)]
pub struct SetStakeAuthority<'info> {
    #[account(
        mut,
        seeds = [QUEST_CONFIG_SEED],
        bump,
        constraint = authority.key() == game_config.authority @ QuestError::Unauthorized,
    )]
    pub game_config: Account<'info, GameConfig>,

    pub authority: Signer<'info>,
}
