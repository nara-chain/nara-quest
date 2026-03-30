use anchor_lang::prelude::*;
use anchor_lang::system_program;
use groth16_solana::groth16::Groth16Verifier;

use crate::constants::*;
use crate::errors::QuestError;
use crate::instructions::submit_answer::VERIFYING_KEY;
use crate::state::*;

pub fn handler_claim_airdrop(
    ctx: Context<ClaimAirdrop>,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
) -> Result<()> {
    let game_config = &ctx.accounts.game_config;
    let airdrop_amount = game_config.airdrop_amount;

    require!(airdrop_amount > 0, QuestError::AirdropDisabled);

    let pool = &ctx.accounts.pool;

    require!(pool.round > 0, QuestError::NoActiveQuest);

    // Verify Groth16 proof (same logic as submit_answer)
    let user_key = ctx.accounts.user.key();
    let user_bytes = user_key.to_bytes();

    let mut pubkey_lo = [0u8; 32];
    pubkey_lo[16..32].copy_from_slice(&user_bytes[16..32]);

    let mut pubkey_hi = [0u8; 32];
    pubkey_hi[16..32].copy_from_slice(&user_bytes[0..16]);

    let mut round_bytes = [0u8; 32];
    round_bytes[24..32].copy_from_slice(&pool.round.to_be_bytes());

    let public_inputs: [[u8; 32]; 4] = [pool.answer_hash, pubkey_lo, pubkey_hi, round_bytes];

    let mut verifier = Groth16Verifier::new(
        &proof_a,
        &proof_b,
        &proof_c,
        &public_inputs,
        &VERIFYING_KEY,
    )
    .map_err(|e| {
        msg!("Groth16Verifier::new failed: {:?}", e);
        QuestError::InvalidProof
    })?;

    verifier.verify().map_err(|e| {
        msg!("Groth16Verifier::verify failed: {:?}", e);
        QuestError::InvalidProof
    })?;

    // Check airdrop limits
    let winner_record = &ctx.accounts.winner_record;
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
        init_if_needed,
        payer = payer,
        space = 8 + WinnerRecord::INIT_SPACE,
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

    /// CHECK: User who proves answer knowledge via ZK proof; pubkey bound in proof
    #[account(mut)]
    pub user: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}
