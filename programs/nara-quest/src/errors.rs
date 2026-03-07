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
}
