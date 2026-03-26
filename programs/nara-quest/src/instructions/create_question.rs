use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::errors::QuestError;
use crate::state::*;

pub fn handler_create_question(
    ctx: Context<CreateQuestion>,
    question: String,
    answer_hash: [u8; 32],
    deadline: i64,
    difficulty: u32,
) -> Result<()> {
    require!(question.len() <= MAX_QUESTION_LEN, QuestError::QuestionTooLong);

    let clock = Clock::get()?;
    require!(deadline > clock.unix_timestamp, QuestError::InvalidDeadline);

    // Dual-role authority check: caller must be authority or quest_authority
    let game_config = &ctx.accounts.game_config;
    let caller_key = ctx.accounts.caller.key();
    let is_admin = caller_key == game_config.authority;
    let is_quest_authority = game_config.quest_authority != Pubkey::default()
        && caller_key == game_config.quest_authority;

    require!(is_admin || is_quest_authority, QuestError::Unauthorized);

    // Minimum interval check: only quest_authority is restricted, admin is exempt
    if !is_admin && game_config.min_quest_interval > 0 {
        let pool = &ctx.accounts.pool;
        if pool.round > 0 {
            let elapsed = clock.unix_timestamp.saturating_sub(pool.created_at);
            require!(
                elapsed >= game_config.min_quest_interval,
                QuestError::QuestIntervalTooShort
            );
        }
    }

    // Calculate reward_count: target is prev_winner_count, but capped to ±10% change per round
    let pool = &mut ctx.accounts.pool;
    let min_reward_count = game_config.min_reward_count;
    let max_reward_count = game_config.max_reward_count;
    let prev_reward_count = pool.reward_count;
    let target = pool.winner_count;

    let adjusted = if prev_reward_count == 0 {
        // First round: no previous baseline, use target directly
        target
    } else {
        // ±10% rate limit (min delta = 1 to avoid getting stuck at small values)
        let max_delta = (prev_reward_count as u64 * REWARD_ADJUST_BPS as u64 / BPS_BASE) as u32;
        let max_delta = if max_delta == 0 { 1 } else { max_delta };
        let upper = prev_reward_count.saturating_add(max_delta);
        let lower = prev_reward_count.saturating_sub(max_delta);
        target.clamp(lower, upper)
    };

    let reward_count = adjusted.clamp(min_reward_count, max_reward_count);

    // Calculate total_reward from config: reward_per_share * reward_count + extra_reward
    let reward_per_share = game_config.reward_per_share;
    let extra_reward = game_config.extra_reward;
    let total_reward = reward_per_share
        .checked_mul(reward_count as u64)
        .unwrap()
        .checked_add(extra_reward)
        .unwrap();

    require!(total_reward > 0, QuestError::InsufficientReward);

    // Check vault balance, top up from treasury if needed
    let vault_info = ctx.accounts.vault.to_account_info();
    let rent = Rent::get()?;
    let vault_rent = rent.minimum_balance(vault_info.data_len());
    let vault_balance = vault_info.lamports().saturating_sub(vault_rent);

    if vault_balance < total_reward {
        let deficit = total_reward - vault_balance;

        // Check treasury balance
        let treasury_info = ctx.accounts.treasury.to_account_info();
        let treasury_rent = rent.minimum_balance(treasury_info.data_len());
        let treasury_available = treasury_info.lamports().saturating_sub(treasury_rent);
        require!(treasury_available >= deficit, QuestError::InsufficientTreasury);

        // Transfer from treasury PDA to vault PDA
        let treasury_bump = ctx.bumps.treasury;
        let treasury_signer_seeds: &[&[&[u8]]] = &[&[TREASURY_SEED, &[treasury_bump]]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.treasury.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
                treasury_signer_seeds,
            ),
            deficit,
        )?;
    }

    // reward_per_winner = reward_per_share + extra_reward / reward_count
    // Integer division remainder stays in vault for next round
    let extra_per_winner = extra_reward / reward_count as u64;
    let reward_per_winner = reward_per_share + extra_per_winner;

    // Calculate staking parameters from previous round's avg_participant_stake
    let prev_avg = pool.avg_participant_stake;
    let stake_high = prev_avg.saturating_mul(game_config.stake_bps_high) / BPS_BASE;
    let stake_low = prev_avg.saturating_mul(game_config.stake_bps_low) / BPS_BASE;

    // Update pool state
    pool.round += 1;
    pool.question = question;
    pool.answer_hash = answer_hash;
    pool.deadline = deadline;
    pool.reward_amount = total_reward;
    pool.reward_count = reward_count;
    pool.reward_per_winner = reward_per_winner;
    pool.winner_count = 0;
    pool.difficulty = difficulty;
    pool.created_at = clock.unix_timestamp;
    pool.stake_high = stake_high;
    pool.stake_low = stake_low;
    pool.avg_participant_stake = 0;

    msg!(
        "Quest created (round {}, reward_count={}, reward_per_winner={})",
        pool.round,
        reward_count,
        reward_per_winner,
    );
    Ok(())
}

#[derive(Accounts)]
pub struct CreateQuestion<'info> {
    #[account(
        seeds = [QUEST_CONFIG_SEED],
        bump,
    )]
    pub game_config: Account<'info, GameConfig>,

    #[account(
        mut,
        seeds = [POOL_SEED],
        bump,
    )]
    pub pool: Account<'info, Pool>,

    /// CHECK: Vault PDA holding reward (system-owned, created on first transfer)
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump,
    )]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: Treasury PDA holding reserves (system-owned)
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump,
    )]
    pub treasury: UncheckedAccount<'info>,

    /// Caller: either authority or quest_authority
    #[account(mut)]
    pub caller: Signer<'info>,

    pub system_program: Program<'info, System>,
}
