use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::QuestError;
use crate::state::*;

pub fn handler_set_reward_config(
    ctx: Context<SetRewardConfig>,
    min_reward_count: u32,
    max_reward_count: u32,
) -> Result<()> {
    require!(
        min_reward_count > 0 && min_reward_count <= max_reward_count,
        QuestError::InvalidMinRewardCount
    );

    let game_config = &mut ctx.accounts.game_config;
    game_config.min_reward_count = min_reward_count;
    game_config.max_reward_count = max_reward_count;

    msg!(
        "Reward config updated: min={}, max={}",
        min_reward_count,
        max_reward_count
    );
    Ok(())
}

#[derive(Accounts)]
pub struct SetRewardConfig<'info> {
    #[account(
        mut,
        seeds = [QUEST_CONFIG_SEED],
        bump,
        constraint = authority.key() == game_config.authority @ QuestError::Unauthorized,
    )]
    pub game_config: Account<'info, GameConfig>,

    pub authority: Signer<'info>,
}
