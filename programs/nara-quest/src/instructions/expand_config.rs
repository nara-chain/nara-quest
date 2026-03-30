use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::errors::QuestError;
use crate::state::*;

pub fn handler_expand_config(ctx: Context<ExpandConfig>, additional_size: u32) -> Result<()> {
    let config_info = ctx.accounts.game_config.to_account_info();
    let old_size = config_info.data_len();
    let new_size = old_size + additional_size as usize;

    // Transfer additional rent from authority
    let rent = Rent::get()?;
    let additional_rent = rent
        .minimum_balance(new_size)
        .saturating_sub(config_info.lamports());

    if additional_rent > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: config_info.clone(),
                },
            ),
            additional_rent,
        )?;
    }

    // Realloc (preserve existing data)
    config_info.resize(new_size)?;

    msg!("GameConfig expanded: {} -> {} bytes (+{})", old_size, new_size, additional_size);
    Ok(())
}

#[derive(Accounts)]
pub struct ExpandConfig<'info> {
    #[account(
        mut,
        seeds = [QUEST_CONFIG_SEED],
        bump,
        constraint = authority.key() == game_config.authority @ QuestError::Unauthorized,
    )]
    pub game_config: Account<'info, GameConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
