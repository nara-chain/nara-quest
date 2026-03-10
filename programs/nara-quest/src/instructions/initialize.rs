use anchor_lang::prelude::*;

use crate::constants::*;
use crate::state::*;

pub fn handler_initialize(ctx: Context<Initialize>) -> Result<()> {
    let game_config = &mut ctx.accounts.game_config;
    game_config.authority = ctx.accounts.authority.key();
    game_config.min_reward_count = DEFAULT_MIN_REWARD_COUNT;
    game_config.max_reward_count = DEFAULT_MAX_REWARD_COUNT;

    let pool = &mut ctx.accounts.pool;
    pool.round = 0;
    pool.winner_count = 0;
    pool.reward_count = 0;
    pool.stake_requirement = 0;
    pool.min_winner_stake = u64::MAX;

    msg!("Nara Quest initialized");
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + GameConfig::INIT_SPACE,
        seeds = [QUEST_CONFIG_SEED],
        bump,
    )]
    pub game_config: Account<'info, GameConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED],
        bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
