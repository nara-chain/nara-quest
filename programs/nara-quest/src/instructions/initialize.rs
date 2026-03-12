use anchor_lang::prelude::*;

use crate::constants::*;
use crate::state::*;

pub fn handler_initialize(ctx: Context<Initialize>) -> Result<()> {
    let game_config = &mut ctx.accounts.game_config;
    game_config.authority = ctx.accounts.authority.key();
    game_config.min_reward_count = DEFAULT_MIN_REWARD_COUNT;
    game_config.max_reward_count = DEFAULT_MAX_REWARD_COUNT;
    game_config.stake_bps_high = DEFAULT_STAKE_BPS_HIGH;
    game_config.stake_bps_low = DEFAULT_STAKE_BPS_LOW;
    game_config.decay_ms = DEFAULT_DECAY_MS;
    game_config.treasury = ctx.accounts.treasury.key();
    game_config.quest_authority = ctx.accounts.authority.key();
    game_config.min_quest_interval = DEFAULT_MIN_QUEST_INTERVAL;
    game_config.reward_per_share = 0;
    game_config.extra_reward = 0;

    let pool = &mut ctx.accounts.pool;
    pool.round = 0;
    pool.winner_count = 0;
    pool.reward_count = 0;
    pool.created_at = 0;
    pool.stake_high = 0;
    pool.stake_low = 0;
    pool.avg_participant_stake = 0;

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

    /// CHECK: Treasury PDA (system-owned)
    #[account(
        seeds = [TREASURY_SEED],
        bump,
    )]
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
