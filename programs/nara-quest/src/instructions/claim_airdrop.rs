use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::errors::QuestError;
use crate::state::*;

pub fn handler_claim_airdrop(ctx: Context<ClaimAirdrop>) -> Result<()> {
    let game_config = &ctx.accounts.game_config;
    let airdrop_amount = game_config.airdrop_amount;

    require!(airdrop_amount > 0, QuestError::AirdropDisabled);

    let pool = &ctx.accounts.pool;
    let winner_record = &ctx.accounts.winner_record;

    require!(
        winner_record.round == pool.round,
        QuestError::AirdropNotEligible
    );
    require!(
        winner_record.airdrop_count < game_config.max_airdrop_count,
        QuestError::AirdropMaxReached
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp - winner_record.last_airdrop_ts >= AIRDROP_COOLDOWN,
        QuestError::AirdropCooldown
    );

    // Check airdrop fund balance
    let airdrop_info = ctx.accounts.airdrop_fund.to_account_info();
    let rent = Rent::get()?;
    let available = airdrop_info
        .lamports()
        .saturating_sub(rent.minimum_balance(airdrop_info.data_len()));
    require!(available >= airdrop_amount, QuestError::InsufficientAirdrop);

    // Transfer from airdrop PDA to user
    let airdrop_bump = ctx.bumps.airdrop_fund;
    let signer_seeds: &[&[&[u8]]] = &[&[AIRDROP_SEED, &[airdrop_bump]]];
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: airdrop_info,
                to: ctx.accounts.user.to_account_info(),
            },
            signer_seeds,
        ),
        airdrop_amount,
    )?;

    // Update winner record
    let winner_record = &mut ctx.accounts.winner_record;
    winner_record.airdrop_count += 1;
    winner_record.last_airdrop_ts = clock.unix_timestamp;

    msg!(
        "Airdrop claimed: user={}, amount={}, total_claims={}",
        ctx.accounts.user.key(),
        airdrop_amount,
        winner_record.airdrop_count
    );
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimAirdrop<'info> {
    #[account(
        seeds = [QUEST_CONFIG_SEED],
        bump,
    )]
    pub game_config: Account<'info, GameConfig>,

    #[account(
        seeds = [POOL_SEED],
        bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [WINNER_SEED, user.key().as_ref()],
        bump,
    )]
    pub winner_record: Account<'info, WinnerRecord>,

    /// CHECK: Airdrop fund PDA (system-owned)
    #[account(
        mut,
        seeds = [AIRDROP_SEED],
        bump,
    )]
    pub airdrop_fund: UncheckedAccount<'info>,

    /// CHECK: User who answered correctly and receives airdrop; identity bound by winner_record PDA seeds
    #[account(mut)]
    pub user: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}
