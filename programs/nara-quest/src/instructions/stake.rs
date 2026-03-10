use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount, SyncNative};

use crate::constants::*;
use crate::state::*;

pub fn handler_stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    // Transfer SOL from user to their stake WSOL ATA
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.stake_token_account.to_account_info(),
            },
        ),
        amount,
    )?;

    // Sync native to update WSOL token balance
    token::sync_native(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        SyncNative {
            account: ctx.accounts.stake_token_account.to_account_info(),
        },
    ))?;

    let stake_record = &mut ctx.accounts.stake_record;
    stake_record.stake_round = ctx.accounts.pool.round;

    msg!("Staked {} lamports as WSOL", amount);
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

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = wsol_mint,
        associated_token::authority = stake_record,
    )]
    pub stake_token_account: Account<'info, TokenAccount>,

    #[account(address = anchor_spl::token::spl_token::native_mint::id())]
    pub wsol_mint: Account<'info, Mint>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}
