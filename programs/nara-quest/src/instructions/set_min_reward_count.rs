use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::QuestError;
use crate::state::*;

pub fn handler_set_min_reward_count(
    ctx: Context<SetMinRewardCount>,
    min_reward_count: u32,
) -> Result<()> {
    let game_config = &mut ctx.accounts.game_config;
    require!(
        min_reward_count > 0 && min_reward_count <= game_config.max_reward_count,
        QuestError::InvalidMinRewardCount
    );
    game_config.min_reward_count = min_reward_count;

    msg!("min_reward_count set to {}", min_reward_count);
    Ok(())
}

#[derive(Accounts)]
pub struct SetMinRewardCount<'info> {
    #[account(
        mut,
        seeds = [QUEST_CONFIG_SEED],
        bump,
        constraint = authority.key() == game_config.authority @ QuestError::Unauthorized,
    )]
    pub game_config: Account<'info, GameConfig>,

    pub authority: Signer<'info>,
}
