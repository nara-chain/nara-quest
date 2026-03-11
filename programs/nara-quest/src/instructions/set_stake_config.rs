use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::QuestError;
use crate::state::*;

pub fn handler_set_stake_config(
    ctx: Context<SetStakeConfig>,
    bps_high: u64,
    bps_low: u64,
    decay_ms: i64,
) -> Result<()> {
    require!(
        bps_high > 0 && bps_low > 0 && decay_ms > 0,
        QuestError::InvalidStakeConfig
    );

    let game_config = &mut ctx.accounts.game_config;
    game_config.stake_bps_high = bps_high;
    game_config.stake_bps_low = bps_low;
    game_config.decay_ms = decay_ms;

    msg!(
        "Stake config updated: bps_high={}, bps_low={}, decay={}ms",
        bps_high,
        bps_low,
        decay_ms
    );
    Ok(())
}

#[derive(Accounts)]
pub struct SetStakeConfig<'info> {
    #[account(
        mut,
        seeds = [QUEST_CONFIG_SEED],
        bump,
        constraint = authority.key() == game_config.authority @ QuestError::Unauthorized,
    )]
    pub game_config: Account<'info, GameConfig>,

    pub authority: Signer<'info>,
}
