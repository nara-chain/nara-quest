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

    // Check quest is active: round > 0 means at least one quest has been created
    require!(pool.round > 0, QuestError::NoActiveQuest);

    let clock = Clock::get()?;
    require!(clock.unix_timestamp < pool.deadline, QuestError::DeadlineExpired);

    // Verify Groth16 proof
    let user_key = ctx.accounts.user.key();
    let user_bytes = user_key.to_bytes();

    let mut pubkey_lo = [0u8; 32];
    pubkey_lo[16..32].copy_from_slice(&user_bytes[16..32]);

    let mut pubkey_hi = [0u8; 32];
    pubkey_hi[16..32].copy_from_slice(&user_bytes[0..16]);

    // round as big-endian 32 bytes (binds proof to specific quest round)
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

        msg!(
            "Answer verified, reward {} lamports (winner {}/{})",
            reward,
            pool.winner_count,
            pool.reward_count
        );
    } else {
        reward_lamports = 0;

        msg!(
            "Answer verified, no reward (winner {}, limit {})",
            pool.winner_count,
            pool.reward_count
        );
    }

    emit!(AnswerSubmitted {
        round: pool.round,
        user: ctx.accounts.user.key(),
        rewarded: reward_lamports > 0,
        reward_lamports,
        agent,
        model,
    });

    Ok(())
}

#[event]
pub struct AnswerSubmitted {
    pub round: u64,
    pub user: Pubkey,
    pub rewarded: bool,
    pub reward_lamports: u64,
    pub agent: String,
    pub model: String,
}

pub const VERIFYING_KEY: Groth16Verifyingkey = Groth16Verifyingkey {
    nr_pubinputs: 4,
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

    /// CHECK: Vault PDA holding reward (system-owned)
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
        nr_pubinputs: 4,
        vk_alpha_g1: VK_ALPHA_G1,
        vk_beta_g2: VK_BETA_G2,
        vk_gamme_g2: VK_GAMMA_G2,
        vk_delta_g2: VK_DELTA_G2,
        vk_ic: &VK_IC,
    };

    // Generated by gen_test_proof.mjs (answer=42, pubkey=aabb...dd, round=0)
    // proof_a is JS-negated: y = BN254_FIELD_MODULUS - y
    const PROOF_A: [u8; 64] = [
        24, 227, 74, 241, 124, 22, 125, 254, 11, 87, 209, 192, 202, 248, 167, 233,
        193, 179, 253, 31, 160, 50, 252, 160, 253, 103, 34, 184, 246, 67, 251, 146,
        47, 139, 108, 230, 255, 81, 26, 218, 136, 245, 79, 255, 174, 172, 139, 64,
        53, 80, 60, 20, 19, 151, 227, 53, 208, 196, 255, 197, 79, 36, 9, 245,
    ];

    const PROOF_B: [u8; 128] = [
        9, 68, 92, 27, 27, 238, 221, 110, 42, 230, 36, 69, 29, 89, 248, 108,
        112, 8, 10, 123, 23, 75, 123, 134, 38, 174, 93, 105, 30, 99, 240, 90,
        16, 143, 114, 222, 127, 122, 227, 53, 221, 120, 162, 73, 209, 56, 133, 243,
        250, 24, 106, 7, 134, 255, 176, 83, 126, 112, 115, 118, 223, 227, 213, 253,
        41, 240, 183, 109, 77, 248, 10, 46, 190, 160, 74, 94, 224, 203, 64, 76,
        215, 221, 158, 246, 242, 142, 133, 212, 49, 71, 203, 160, 20, 176, 162, 114,
        32, 237, 30, 123, 253, 104, 196, 16, 21, 187, 91, 203, 123, 57, 212, 196,
        202, 222, 131, 210, 26, 193, 15, 201, 31, 152, 41, 163, 73, 253, 148, 141,
    ];

    const PROOF_C: [u8; 64] = [
        23, 156, 13, 137, 147, 21, 236, 219, 111, 237, 108, 207, 119, 235, 253, 176,
        11, 213, 234, 221, 153, 53, 232, 101, 18, 29, 147, 227, 28, 129, 20, 169,
        21, 43, 10, 176, 33, 178, 51, 211, 150, 164, 86, 133, 60, 141, 161, 9,
        231, 134, 110, 23, 213, 214, 0, 111, 187, 229, 26, 74, 10, 20, 189, 238,
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
        // round = 0 for test
        let round: [u8; 32] = [0u8; 32];
        let public_inputs: [[u8; 32]; 4] = [ANSWER_HASH, PUBKEY_LO, PUBKEY_HI, round];

        let mut verifier = Groth16Verifier::new(
            &PROOF_A, &PROOF_B, &PROOF_C,
            &public_inputs, &TEST_VK,
        ).expect("Groth16Verifier::new should succeed");

        verifier.verify().expect("Groth16 proof verification should succeed");
    }
}
