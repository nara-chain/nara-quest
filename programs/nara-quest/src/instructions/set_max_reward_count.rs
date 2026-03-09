use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::QuestError;
use crate::state::*;

pub fn handler_set_max_reward_count(
    ctx: Context<SetMaxRewardCount>,
    max_reward_count: u32,
) -> Result<()> {
    require!(max_reward_count >= MIN_REWARD_COUNT, QuestError::InvalidMaxRewardCount);

    let game_config = &mut ctx.accounts.game_config;
    game_config.max_reward_count = max_reward_count;

    msg!("max_reward_count set to {}", max_reward_count);
    Ok(())
}

#[derive(Accounts)]
pub struct SetMaxRewardCount<'info> {
    #[account(
        mut,
        seeds = [QUEST_CONFIG_SEED],
        bump,
        constraint = authority.key() == game_config.authority @ QuestError::Unauthorized,
    )]
    pub game_config: Account<'info, GameConfig>,

    pub authority: Signer<'info>,
}
