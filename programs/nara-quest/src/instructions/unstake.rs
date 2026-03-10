use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer, CloseAccount};

use crate::constants::*;
use crate::errors::QuestError;
use crate::state::*;

pub fn handler_unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    let stake_record = &ctx.accounts.stake_record;
    let pool = &ctx.accounts.pool;

    // Can unstake if round advanced OR deadline passed
    let clock = Clock::get()?;
    let can_unstake = pool.round > stake_record.stake_round
        || (pool.deadline > 0 && clock.unix_timestamp > pool.deadline);
    require!(can_unstake, QuestError::UnstakeNotReady);

    // Check sufficient WSOL balance
    require!(ctx.accounts.stake_token_account.amount >= amount, QuestError::InsufficientStakeBalance);

    // PDA signer seeds for stake_record
    let user_key = ctx.accounts.user.key();
    let stake_bump = ctx.bumps.stake_record;
    let signer_seeds: &[&[&[u8]]] = &[&[STAKE_SEED, user_key.as_ref(), &[stake_bump]]];

    // Transfer WSOL from stake ATA to user's temporary WSOL ATA
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.stake_token_account.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.stake_record.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // Close user's WSOL ATA to unwrap WSOL back to SOL
    token::close_account(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.user_token_account.to_account_info(),
            destination: ctx.accounts.user.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        },
    ))?;

    msg!("Unstaked {} lamports (WSOL -> SOL)", amount);
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

    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = stake_record,
    )]
    pub stake_token_account: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = wsol_mint,
        associated_token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(address = anchor_spl::token::spl_token::native_mint::id())]
    pub wsol_mint: Account<'info, Mint>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}
