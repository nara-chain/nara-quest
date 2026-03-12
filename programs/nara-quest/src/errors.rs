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

    #[msg("Invalid reward config: need 0 < min <= max")]
    InvalidMinRewardCount,

    #[msg("Stake config values must be > 0")]
    InvalidStakeConfig,

    #[msg("Cannot unstake until round advances or deadline passes")]
    UnstakeNotReady,

    #[msg("Unstake amount exceeds staked balance")]
    InsufficientStakeBalance,

    #[msg("Stake does not meet dynamic requirement")]
    InsufficientStake,

    #[msg("Quest interval too short")]
    QuestIntervalTooShort,

    #[msg("Insufficient treasury balance")]
    InsufficientTreasury,

    #[msg("Invalid reward config: reward_per_share and extra_reward cannot both be 0")]
    InvalidRewardPerShare,
}
