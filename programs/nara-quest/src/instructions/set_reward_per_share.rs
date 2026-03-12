use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::QuestError;
use crate::state::*;

pub fn handler_set_reward_per_share(
    ctx: Context<SetRewardPerShare>,
    reward_per_share: u64,
    extra_reward: u64,
) -> Result<()> {
    require!(
        reward_per_share > 0 || extra_reward > 0,
        QuestError::InvalidRewardPerShare
    );

    let game_config = &mut ctx.accounts.game_config;
    game_config.reward_per_share = reward_per_share;
    game_config.extra_reward = extra_reward;

    msg!(
        "Reward config updated: reward_per_share={}, extra_reward={}",
        reward_per_share,
        extra_reward
    );
    Ok(())
}

#[derive(Accounts)]
pub struct SetRewardPerShare<'info> {
    #[account(
        mut,
        seeds = [QUEST_CONFIG_SEED],
        bump,
        constraint = authority.key() == game_config.authority @ QuestError::Unauthorized,
    )]
    pub game_config: Account<'info, GameConfig>,

    pub authority: Signer<'info>,
}
