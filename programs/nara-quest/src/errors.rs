use anchor_lang::prelude::*;

#[error_code]
pub enum QuestError {
    #[msg("Only the authority can perform this action")]
    Unauthorized,

    #[msg("No active quest")]
    NoActiveQuest,

    #[msg("The deadline for this question has passed")]
    DeadlineExpired,

    #[msg("ZK proof verification failed")]
    InvalidProof,

    #[msg("Deadline must be in the future")]
    InvalidDeadline,

    #[msg("Reward amount must be greater than zero")]
    InsufficientReward,

    #[msg("Question exceeds maximum length")]
    QuestionTooLong,

    #[msg("Already answered this round")]
    AlreadyAnswered,

    #[msg("min_reward_count must be > 0 and <= max_reward_count")]
    InvalidMinRewardCount,

    #[msg("max_reward_count must be >= min_reward_count")]
    InvalidMaxRewardCount,

    #[msg("Cannot unstake until round advances or deadline passes")]
    UnstakeNotReady,

    #[msg("Unstake amount exceeds staked balance")]
    InsufficientStakeBalance,
}
