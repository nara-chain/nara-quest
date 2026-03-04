use anchor_lang::prelude::*;

#[error_code]
pub enum QuestError {
    #[msg("Only the authority can perform this action")]
    Unauthorized,

    #[msg("Pool has no active question")]
    PoolNotActive,

    #[msg("The deadline for this question has passed")]
    DeadlineExpired,

    #[msg("ZK proof verification failed")]
    InvalidProof,

    #[msg("Deadline must be in the future")]
    InvalidDeadline,

    #[msg("Reward amount must be greater than zero")]
    InsufficientReward,

    #[msg("Pool balance insufficient for reward transfer")]
    InsufficientPoolBalance,

    #[msg("Question exceeds maximum length")]
    QuestionTooLong,

    #[msg("Already answered this round")]
    AlreadyAnswered,
}
