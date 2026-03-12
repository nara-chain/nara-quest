use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::QuestError;
use crate::state::*;

pub fn handler_set_quest_interval(
    ctx: Context<SetQuestInterval>,
    min_quest_interval: i64,
) -> Result<()> {
    let game_config = &mut ctx.accounts.game_config;
    game_config.min_quest_interval = min_quest_interval;

    msg!("Quest interval updated: {}s", min_quest_interval);
    Ok(())
}

#[derive(Accounts)]
pub struct SetQuestInterval<'info> {
    #[account(
        mut,
        seeds = [QUEST_CONFIG_SEED],
        bump,
        constraint = authority.key() == game_config.authority @ QuestError::Unauthorized,
    )]
    pub game_config: Account<'info, GameConfig>,

    pub authority: Signer<'info>,
}
