use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::errors::QuestError;
use crate::state::*;

pub fn handler_unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
    require!(amount > 0, QuestError::InsufficientStake);

    let stake_record = &mut ctx.accounts.stake_record;
    let pool = &ctx.accounts.pool;

    // Must wait for round to advance after staking
    require!(pool.round > stake_record.stake_round, QuestError::UnstakeNotReady);

    // Check sufficient staked balance
    require!(stake_record.amount >= amount, QuestError::NothingStaked);

    // Transfer lamports from stake vault to user
    let vault_bump = ctx.bumps.stake_vault;
    let signer_seeds: &[&[&[u8]]] = &[&[STAKE_VAULT_SEED, &[vault_bump]]];
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.stake_vault.to_account_info(),
                to: ctx.accounts.user.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    stake_record.amount -= amount;

    msg!("Unstaked {} lamports (remaining: {})", amount, stake_record.amount);
    Ok(())
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(
        seeds = [POOL_SEED],
        bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [STAKE_SEED, user.key().as_ref()],
        bump,
    )]
    pub stake_record: Account<'info, StakeRecord>,

    /// CHECK: Stake vault PDA (system-owned)
    #[account(
        mut,
        seeds = [STAKE_VAULT_SEED],
        bump,
    )]
    pub stake_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}
