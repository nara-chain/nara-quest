use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::state::*;

pub fn handler_stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    // Transfer lamports from user to stake vault
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.stake_vault.to_account_info(),
            },
        ),
        amount,
    )?;

    let stake_record = &mut ctx.accounts.stake_record;
    stake_record.amount += amount;
    stake_record.stake_round = ctx.accounts.pool.round;

    msg!("Staked {} lamports (total: {})", amount, stake_record.amount);
    Ok(())
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(
        seeds = [POOL_SEED],
        bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + StakeRecord::INIT_SPACE,
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
