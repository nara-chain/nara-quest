use anchor_lang::prelude::*;
use anchor_lang::system_program;
use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};

use crate::constants::*;
use crate::errors::QuestError;
use crate::state::*;

pub fn handler_submit_answer(
    ctx: Context<SubmitAnswer>,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    agent: String,
    model: String,
) -> Result<()> {
    let pool = &ctx.accounts.pool;

    // Check pool is active and deadline not passed
    require!(pool.is_active, QuestError::PoolNotActive);

    let clock = Clock::get()?;
    require!(clock.unix_timestamp < pool.deadline, QuestError::DeadlineExpired);

    // Verify Groth16 proof
    let user_key = ctx.accounts.user.key();
    let user_bytes = user_key.to_bytes();

    let mut pubkey_lo = [0u8; 32];
    pubkey_lo[16..32].copy_from_slice(&user_bytes[16..32]);

    let mut pubkey_hi = [0u8; 32];
    pubkey_hi[16..32].copy_from_slice(&user_bytes[0..16]);

    let public_inputs: [[u8; 32]; 3] = [pool.answer_hash, pubkey_lo, pubkey_hi];

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

    // Record winner (init_if_needed + round check ensures no duplicates per round)
    let pool_round = ctx.accounts.pool.round;
    let winner_record = &mut ctx.accounts.winner_record;
    require!(winner_record.round != pool_round, QuestError::AlreadyAnswered);
    winner_record.round = pool_round;

    // Increment winner count
    let pool = &mut ctx.accounts.pool;
    pool.winner_count += 1;

    // Instant reward: transfer if within reward_count limit
    let reward_lamports;
    if pool.winner_count <= pool.reward_count {
        let reward = pool.reward_per_winner;
        reward_lamports = reward;

        // Transfer lamports from vault PDA to user via system_program::transfer
        let vault_bump = ctx.bumps.vault;
        let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, &[vault_bump]]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user.to_account_info(),
                },
                signer_seeds,
            ),
            reward,
        )?;

        winner_record.rewarded = true;

        msg!(
            "Answer verified, reward {} lamports (winner {}/{})",
            reward,
            pool.winner_count,
            pool.reward_count
        );
    } else {
        reward_lamports = 0;
        winner_record.rewarded = false;

        msg!(
            "Answer verified, no reward (winner {}, limit {})",
            pool.winner_count,
            pool.reward_count
        );
    }

    emit!(AnswerSubmitted {
        round: pool.round,
        question_id: pool.question_id,
        user: ctx.accounts.user.key(),
        rewarded: winner_record.rewarded,
        reward_lamports,
        agent,
        model,
    });

    Ok(())
}

#[event]
pub struct AnswerSubmitted {
    pub round: u64,
    pub question_id: u64,
    pub user: Pubkey,
    pub rewarded: bool,
    pub reward_lamports: u64,
    pub agent: String,
    pub model: String,
}

pub const VERIFYING_KEY: Groth16Verifyingkey = Groth16Verifyingkey {
    nr_pubinputs: 3,
    vk_alpha_g1: VK_ALPHA_G1,
    vk_beta_g2: VK_BETA_G2,
    vk_gamme_g2: VK_GAMMA_G2,
    vk_delta_g2: VK_DELTA_G2,
    vk_ic: &VK_IC,
};

#[derive(Accounts)]
pub struct SubmitAnswer<'info> {
    #[account(
        mut,
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

    /// CHECK: Vault PDA holding reward SOL (system-owned)
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump,
    )]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: User whose answer is being submitted; pubkey is bound in the ZK proof
    #[account(mut)]
    pub user: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[cfg(test)]
mod tests {
    use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};
    use crate::constants::*;

    const TEST_VK: Groth16Verifyingkey = Groth16Verifyingkey {
        nr_pubinputs: 3,
        vk_alpha_g1: VK_ALPHA_G1,
        vk_beta_g2: VK_BETA_G2,
        vk_gamme_g2: VK_GAMMA_G2,
        vk_delta_g2: VK_DELTA_G2,
        vk_ic: &VK_IC,
    };

    // Generated by gen_test_proof.mjs (answer=42, pubkey=aabb...dd)
    // proof_a is JS-negated: y = BN254_FIELD_MODULUS - y
    const PROOF_A: [u8; 64] = [
        44, 195, 114, 230, 153, 179, 141, 55, 34, 185, 100, 219, 10, 89, 210, 134,
        144, 203, 26, 235, 85, 76, 177, 217, 205, 157, 206, 120, 24, 125, 23, 34,
        46, 134, 162, 246, 211, 199, 8, 232, 86, 47, 96, 121, 202, 12, 142, 106,
        184, 61, 37, 132, 205, 137, 83, 166, 92, 160, 169, 211, 166, 44, 176, 130,
    ];

    const PROOF_B: [u8; 128] = [
        32, 208, 218, 240, 18, 138, 12, 51, 141, 169, 200, 154, 157, 248, 98, 106,
        64, 243, 80, 117, 145, 143, 187, 227, 189, 80, 184, 182, 4, 48, 249, 152,
        31, 42, 5, 6, 169, 36, 158, 44, 235, 240, 225, 157, 130, 155, 255, 149,
        159, 54, 139, 236, 69, 3, 53, 165, 81, 104, 83, 115, 63, 38, 174, 111,
        31, 83, 16, 158, 167, 139, 189, 12, 249, 84, 114, 73, 170, 56, 202, 36,
        176, 194, 221, 87, 148, 8, 39, 122, 55, 150, 147, 54, 185, 2, 253, 198,
        31, 250, 232, 219, 60, 134, 225, 28, 87, 91, 222, 227, 39, 29, 83, 135,
        193, 70, 191, 151, 212, 38, 7, 238, 116, 211, 212, 131, 6, 30, 70, 223,
    ];

    const PROOF_C: [u8; 64] = [
        29, 48, 4, 117, 49, 43, 9, 231, 254, 244, 20, 112, 11, 137, 50, 51,
        156, 84, 59, 160, 70, 244, 68, 216, 229, 16, 52, 153, 75, 115, 121, 118,
        31, 197, 222, 184, 8, 249, 106, 38, 166, 123, 215, 130, 171, 37, 116, 110,
        168, 206, 180, 121, 73, 13, 23, 232, 199, 235, 206, 78, 58, 255, 108, 21,
    ];

    const ANSWER_HASH: [u8; 32] = [
        27, 64, 141, 175, 235, 237, 223, 8, 113, 56, 131, 153, 177, 229, 59, 208,
        101, 253, 112, 241, 133, 128, 190, 92, 221, 225, 93, 126, 178, 197, 39, 67,
    ];

    const PUBKEY_LO: [u8; 32] = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        170, 187, 204, 221, 170, 187, 204, 221, 170, 187, 204, 221, 170, 187, 204, 221,
    ];

    const PUBKEY_HI: [u8; 32] = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        170, 187, 204, 221, 170, 187, 204, 221, 170, 187, 204, 221, 170, 187, 204, 221,
    ];

    #[test]
    fn test_groth16_proof_verification() {
        let public_inputs: [[u8; 32]; 3] = [ANSWER_HASH, PUBKEY_LO, PUBKEY_HI];

        let mut verifier = Groth16Verifier::new(
            &PROOF_A, &PROOF_B, &PROOF_C,
            &public_inputs, &TEST_VK,
        ).expect("Groth16Verifier::new should succeed");

        verifier.verify().expect("Groth16 proof verification should succeed");
    }
}
