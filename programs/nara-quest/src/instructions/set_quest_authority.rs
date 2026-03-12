use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::QuestError;
use crate::state::*;

pub fn handler_set_quest_authority(
    ctx: Context<SetQuestAuthority>,
    new_quest_authority: Pubkey,
) -> Result<()> {
    let game_config = &mut ctx.accounts.game_config;
    let old = game_config.quest_authority;
    game_config.quest_authority = new_quest_authority;

    msg!(
        "Quest authority updated from {} to {}",
        old,
        new_quest_authority
    );
    Ok(())
}

#[derive(Accounts)]
pub struct SetQuestAuthority<'info> {
    #[account(
        mut,
        seeds = [QUEST_CONFIG_SEED],
        bump,
        constraint = authority.key() == game_config.authority @ QuestError::Unauthorized,
    )]
    pub game_config: Account<'info, GameConfig>,

    pub authority: Signer<'info>,
}
