use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::QuestError;
use crate::state::*;

pub fn handler_adjust_free_stake(
    ctx: Context<AdjustFreeStake>,
    delta: i32,
    reason: String,
) -> Result<()> {
    require!(delta != 0, QuestError::InvalidDelta);

    let stake_record = &mut ctx.accounts.stake_record;
    let old_credits = stake_record.free_credits;

    if delta > 0 {
        stake_record.free_credits = old_credits
            .checked_add(delta as u32)
            .ok_or(error!(QuestError::FreeCreditsOverflow))?;
    } else {
        stake_record.free_credits = old_credits.saturating_sub(delta.unsigned_abs());
    }

    msg!(
        "Free stake adjusted: user={}, delta={}, credits={}->{}, reason={}",
        ctx.accounts.user.key(),
        delta,
        old_credits,
        stake_record.free_credits,
        reason
    );
    Ok(())
}

#[derive(Accounts)]
pub struct AdjustFreeStake<'info> {
    #[account(
        seeds = [QUEST_CONFIG_SEED],
        bump,
        constraint = caller.key() == game_config.stake_authority
            && game_config.stake_authority != Pubkey::default()
            @ QuestError::Unauthorized,
    )]
    pub game_config: Account<'info, GameConfig>,

    #[account(
        init_if_needed,
        payer = caller,
        space = 8 + StakeRecord::INIT_SPACE,
        seeds = [STAKE_SEED, user.key().as_ref()],
        bump,
    )]
    pub stake_record: Account<'info, StakeRecord>,

    /// CHECK: Target user address, does not need to sign
    pub user: UncheckedAccount<'info>,

    #[account(mut)]
    pub caller: Signer<'info>,

    pub system_program: Program<'info, System>,
}
