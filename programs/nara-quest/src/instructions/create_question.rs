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
    reward_amount: u64,
    difficulty: u32,
) -> Result<()> {
    require!(question.len() <= MAX_QUESTION_LEN, QuestError::QuestionTooLong);
    require!(reward_amount > 0, QuestError::InsufficientReward);

    let clock = Clock::get()?;
    require!(deadline > clock.unix_timestamp, QuestError::InvalidDeadline);

    // Read vault leftover from previous round (exclude rent-exempt minimum)
    let vault_info = ctx.accounts.vault.to_account_info();
    let rent = Rent::get()?;
    let vault_rent = rent.minimum_balance(vault_info.data_len());
    let vault_leftover = vault_info.lamports().saturating_sub(vault_rent);

    // Transfer reward from authority to vault PDA
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        reward_amount,
    )?;

    // Total reward = new deposit + leftover from previous round
    let total_reward = reward_amount + vault_leftover;

    // Calculate reward_count: min(max(previous_winner_count, min_reward_count), max_reward_count)
    let pool = &mut ctx.accounts.pool;
    let game_config = &ctx.accounts.game_config;
    let min_reward_count = game_config.min_reward_count;
    let max_reward_count = game_config.max_reward_count;
    let prev_winner_count = pool.winner_count;

    let uncapped = if prev_winner_count >= min_reward_count {
        prev_winner_count
    } else {
        min_reward_count
    };
    let reward_count = if uncapped > max_reward_count {
        max_reward_count
    } else {
        uncapped
    };

    let reward_per_winner = total_reward / reward_count as u64;

    // Calculate staking parameters from previous round's avg_participant_stake (bps / 10000)
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
        mut,
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

    #[account(
        mut,
        constraint = authority.key() == game_config.authority @ QuestError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
