import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { NaraQuest } from "../target/types/nara_quest";
import { expect } from "chai";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as path from "path";

// -- Type definitions for untyped dependencies --

interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}

interface SnarkJS {
  groth16: {
    fullProve(
      input: Record<string, string>,
      wasmFile: string,
      zkeyFile: string
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
  };
}

interface PoseidonHasher {
  (inputs: bigint[]): Uint8Array;
  F: { toString(val: Uint8Array): string };
}

// BN254 base field modulus (for G1 point negation)
const BN254_FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583"
);

const CIRCUIT_WASM = path.resolve(
  __dirname,
  "../circuits/build/answer_proof_js/answer_proof.wasm"
);
const ZKEY_PATH = path.resolve(
  __dirname,
  "../circuits/build/answer_proof_final.zkey"
);

// Helper: Convert decimal string to 32-byte big-endian buffer
function toBigEndian32(decStr: string): Buffer {
  let hex = BigInt(decStr).toString(16);
  hex = hex.padStart(64, "0");
  return Buffer.from(hex, "hex");
}

// Helper: Negate G1 y-coordinate (BN254: -y = p - y)
function negateG1Y(yDecStr: string): Buffer {
  const y = BigInt(yDecStr);
  const negY = BN254_FIELD_MODULUS - y;
  const hex = negY.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

// Convert snarkjs proof to Solana format
function proofToSolana(proof: Groth16Proof): {
  proofA: number[];
  proofB: number[];
  proofC: number[];
} {
  const proofA = [
    ...toBigEndian32(proof.pi_a[0]),
    ...negateG1Y(proof.pi_a[1]),
  ];
  const proofB = [
    ...toBigEndian32(proof.pi_b[0][1]),
    ...toBigEndian32(proof.pi_b[0][0]),
    ...toBigEndian32(proof.pi_b[1][1]),
    ...toBigEndian32(proof.pi_b[1][0]),
  ];
  const proofC = [
    ...toBigEndian32(proof.pi_c[0]),
    ...toBigEndian32(proof.pi_c[1]),
  ];
  return {
    proofA: Array.from(proofA),
    proofB: Array.from(proofB),
    proofC: Array.from(proofC),
  };
}

// Compute pubkey_lo and pubkey_hi as decimal strings for snarkjs
function pubkeyToCircuitInputs(pubkey: PublicKey): {
  lo: string;
  hi: string;
} {
  const bytes = pubkey.toBuffer();
  const loBuf = bytes.subarray(16, 32);
  const lo = BigInt("0x" + loBuf.toString("hex")).toString();
  const hiBuf = bytes.subarray(0, 16);
  const hi = BigInt("0x" + hiBuf.toString("hex")).toString();
  return { lo, hi };
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Convert Poseidon hash (field element) to on-chain [u8; 32] format
function hashToOnChain(hashStr: string): number[] {
  return Array.from(toBigEndian32(hashStr));
}

// Generate ZK proof for a given answer and user pubkey
async function generateProof(
  snarkjs: SnarkJS,
  answer: string,
  answerHashStr: string,
  userPubkey: PublicKey,
  round: string
): Promise<{ proofA: number[]; proofB: number[]; proofC: number[] }> {
  const { lo, hi } = pubkeyToCircuitInputs(userPubkey);
  const { proof } = await snarkjs.groth16.fullProve(
    {
      answer: answer,
      answer_hash: answerHashStr,
      pubkey_lo: lo,
      pubkey_hi: hi,
      round: round,
    },
    CIRCUIT_WASM,
    ZKEY_PATH
  );
  return proofToSolana(proof);
}

// Derive winner record PDA (single pool, no pool_id in seeds)
function winnerRecordPda(
  programId: PublicKey,
  user: PublicKey
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("quest_winner"), user.toBuffer()],
    programId
  );
  return pda;
}

describe("nara-quest", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.naraQuest as Program<NaraQuest>;
  const authority = provider.wallet;

  // PDAs
  let gameConfigPda: PublicKey;
  let poolPda: PublicKey;
  let treasuryPda: PublicKey;

  // sponsor: pays gas and rent for submit on behalf of users
  const sponsor = Keypair.generate();

  // user1 and user2 for testing
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  // quest_authority keypair for testing
  const questAuthority = Keypair.generate();

  // ZK dependencies (loaded dynamically)
  let snarkjs: SnarkJS;
  let poseidon: PoseidonHasher;

  // Test answer
  const TEST_ANSWER = "42";
  let answerHashStr: string;
  let answerHashOnChain: number[];

  // Short deadline for testing (10 seconds)
  const DEADLINE_SECONDS = 10;

  // Default difficulty for tests
  const DEFAULT_DIFFICULTY = 1;

  // Default agent/model for tests
  const TEST_AGENT = "test-agent-v1";
  const TEST_MODEL = "claude-sonnet-4-6";

  // Reward config for tests
  const REWARD_PER_SHARE = 0.1 * LAMPORTS_PER_SOL; // 0.1 SOL per share
  const EXTRA_REWARD = 0;

  before(async () => {
    snarkjs = await import("snarkjs") as unknown as SnarkJS;
    const circomlibjs = await import("circomlibjs");
    poseidon = await circomlibjs.buildPoseidon() as PoseidonHasher;

    const hashRaw = poseidon([BigInt(TEST_ANSWER)]);
    answerHashStr = poseidon.F.toString(hashRaw);
    answerHashOnChain = hashToOnChain(answerHashStr);

    [gameConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("quest_config")],
      program.programId
    );
    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("quest_pool")],
      program.programId
    );
    [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("quest_treasury")],
      program.programId
    );

    // sponsor pays gas/rent for submit
    const sponsorSig = await provider.connection.requestAirdrop(
      sponsor.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sponsorSig);

    // user1 needs SOL for authority tests
    const user1Sig = await provider.connection.requestAirdrop(
      user1.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(user1Sig);

    // quest_authority needs SOL for gas
    const qaSig = await provider.connection.requestAirdrop(
      questAuthority.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(qaSig);

    // user2 has zero SOL — fully sponsored
  });

  // Helper: fund treasury PDA with SOL
  async function fundTreasury(amount: number) {
    const tx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: treasuryPda,
        lamports: amount,
      })
    );
    await provider.sendAndConfirm(tx);
  }

  describe("initialize", () => {
    it("initializes game config and pool", async () => {
      await program.methods
        .initialize()
        .rpc();

      const gameConfig = await program.account.gameConfig.fetch(gameConfigPda);
      expect(gameConfig.authority.toBase58()).to.equal(
        authority.publicKey.toBase58()
      );
      expect(gameConfig.questAuthority.toBase58()).to.equal(
        authority.publicKey.toBase58()
      );
      expect(gameConfig.treasury.toBase58()).to.equal(
        treasuryPda.toBase58()
      );
      expect(gameConfig.minQuestInterval.toNumber()).to.equal(30);
      expect(gameConfig.rewardPerShare.toNumber()).to.equal(0);
      expect(gameConfig.extraReward.toNumber()).to.equal(0);

      const pool = await program.account.pool.fetch(poolPda);
      expect(pool.round.toNumber()).to.equal(0);
      expect(pool.boostWinnerCount).to.equal(0);
      expect(pool.boostRewardCount).to.equal(0);
      expect(pool.stakeHigh.toNumber()).to.equal(0);
      expect(pool.stakeLow.toNumber()).to.equal(0);
      expect(pool.avgParticipantStake.toNumber()).to.equal(0);

      expect(gameConfig.minRewardCount).to.equal(10);
      expect(gameConfig.maxRewardCount).to.equal(16384);
      expect(gameConfig.stakeBpsHigh.toNumber()).to.equal(100000);
      expect(gameConfig.stakeBpsLow.toNumber()).to.equal(1000);
      expect(gameConfig.decayMs.toNumber()).to.equal(2000);
    });

    it("cannot initialize twice", async () => {
      try {
        await program.methods
          .initialize()
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        // Expected: account already exists
      }
    });
  });

  describe("set_reward_per_share", () => {
    it("authority can set reward per share", async () => {
      await program.methods
        .setRewardPerShare(
          new anchor.BN(REWARD_PER_SHARE),
          new anchor.BN(EXTRA_REWARD)
        )
        .rpc();

      const gameConfig = await program.account.gameConfig.fetch(gameConfigPda);
      expect(gameConfig.rewardPerShare.toNumber()).to.equal(REWARD_PER_SHARE);
      expect(gameConfig.extraReward.toNumber()).to.equal(EXTRA_REWARD);
    });

    it("fails if both reward_per_share and extra_reward are 0", async () => {
      try {
        await program.methods
          .setRewardPerShare(new anchor.BN(0), new anchor.BN(0))
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("InvalidRewardPerShare");
      }
    });

    it("fails if non-authority tries to set", async () => {
      try {
        await program.methods
          .setRewardPerShare(
            new anchor.BN(LAMPORTS_PER_SOL),
            new anchor.BN(0)
          )
          .accountsPartial({
            authority: user1.publicKey,
          })
          .signers([user1])
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("Unauthorized");
      }
    });
  });

  describe("set_quest_authority", () => {
    it("authority can set quest_authority", async () => {
      await program.methods
        .setQuestAuthority(questAuthority.publicKey)
        .rpc();

      const gameConfig = await program.account.gameConfig.fetch(gameConfigPda);
      expect(gameConfig.questAuthority.toBase58()).to.equal(
        questAuthority.publicKey.toBase58()
      );
    });

    it("fails if non-authority tries to set quest_authority", async () => {
      try {
        await program.methods
          .setQuestAuthority(user1.publicKey)
          .accountsPartial({
            authority: user1.publicKey,
          })
          .signers([user1])
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("Unauthorized");
      }
    });
  });

  describe("set_quest_interval", () => {
    it("authority can set quest interval", async () => {
      await program.methods
        .setQuestInterval(new anchor.BN(5))
        .rpc();

      const gameConfig = await program.account.gameConfig.fetch(gameConfigPda);
      expect(gameConfig.minQuestInterval.toNumber()).to.equal(5);
    });

    it("can set interval to 0 (disable)", async () => {
      await program.methods
        .setQuestInterval(new anchor.BN(0))
        .rpc();

      const gameConfig = await program.account.gameConfig.fetch(gameConfigPda);
      expect(gameConfig.minQuestInterval.toNumber()).to.equal(0);
    });
  });

  describe("create_question", () => {
    before(async () => {
      // Fund treasury with enough SOL for tests
      await fundTreasury(10 * LAMPORTS_PER_SOL);
    });

    it("creates first question with default reward_count=10", async () => {
      const deadline = new anchor.BN(
        Math.floor(Date.now() / 1000) + DEADLINE_SECONDS
      );

      await program.methods
        .createQuestion(
          "What is the answer to life?",
          answerHashOnChain,
          deadline,
          DEFAULT_DIFFICULTY
        )
        .accountsPartial({
          caller: authority.publicKey,
        })
        .rpc();

      const pool = await program.account.pool.fetch(poolPda);
      expect(pool.round.toNumber()).to.equal(1);
      expect(pool.question).to.equal("What is the answer to life?");
      expect(pool.difficulty).to.equal(DEFAULT_DIFFICULTY);
      expect(pool.boostWinnerCount).to.equal(0);
      expect(pool.boostRewardCount).to.equal(10);
      // total_reward = reward_per_share * reward_count + extra_reward
      // = 0.1 SOL * 10 + 0 = 1 SOL
      expect(pool.rewardAmount.toNumber()).to.equal(1 * LAMPORTS_PER_SOL);
      // Boost PoMI single-track: reward_per_winner = reward_per_share + extra/reward_count
      // extra_reward = 0, so boostRewardPerWinner = REWARD_PER_SHARE
      expect(pool.boostRewardPerWinner.toNumber()).to.equal(REWARD_PER_SHARE);
    });

    it("quest_authority can create question", async () => {
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

      await program.methods
        .createQuestion(
          "Quest authority question",
          answerHashOnChain,
          deadline,
          DEFAULT_DIFFICULTY
        )
        .accountsPartial({
          caller: questAuthority.publicKey,
        })
        .signers([questAuthority])
        .rpc();

      const pool = await program.account.pool.fetch(poolPda);
      expect(pool.question).to.equal("Quest authority question");
    });

    it("fails if non-authority and non-quest_authority tries to create question", async () => {
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

      try {
        await program.methods
          .createQuestion(
            "Unauthorized question",
            answerHashOnChain,
            deadline,
            DEFAULT_DIFFICULTY
          )
          .accountsPartial({
            caller: user1.publicKey,
          })
          .signers([user1])
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("Unauthorized");
      }
    });

    it("fails if deadline is in the past", async () => {
      const pastDeadline = new anchor.BN(Math.floor(Date.now() / 1000) - 100);

      try {
        await program.methods
          .createQuestion(
            "Past deadline question",
            answerHashOnChain,
            pastDeadline,
            DEFAULT_DIFFICULTY
          )
          .accountsPartial({
            caller: authority.publicKey,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("InvalidDeadline");
      }
    });

    it("quest_authority respects min interval", async () => {
      // Set a 60-second interval
      await program.methods
        .setQuestInterval(new anchor.BN(60))
        .rpc();

      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

      try {
        await program.methods
          .createQuestion(
            "Too soon question",
            answerHashOnChain,
            deadline,
            DEFAULT_DIFFICULTY
          )
          .accountsPartial({
            caller: questAuthority.publicKey,
          })
          .signers([questAuthority])
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("QuestIntervalTooShort");
      }

      // Admin is exempt from interval check
      await program.methods
        .createQuestion(
          "Admin bypasses interval",
          answerHashOnChain,
          deadline,
          DEFAULT_DIFFICULTY
        )
        .accountsPartial({
          caller: authority.publicKey,
        })
        .rpc();

      const pool = await program.account.pool.fetch(poolPda);
      expect(pool.question).to.equal("Admin bypasses interval");

      // Reset interval to 0
      await program.methods
        .setQuestInterval(new anchor.BN(0))
        .rpc();
    });
  });

  describe("submit_answer (instant reward)", () => {
    before(async () => {
      // Boost PoMI: set authority as stake_authority and grant credits to test users
      await program.methods
        .setStakeAuthority(authority.publicKey)
        .rpc();
      for (const u of [user1, user2]) {
        await program.methods
          .adjustFreeStake(5, "test setup")
          .accountsPartial({ user: u.publicKey, caller: authority.publicKey })
          .rpc();
      }

      // Create a fresh question for submit tests
      const deadline = new anchor.BN(
        Math.floor(Date.now() / 1000) + DEADLINE_SECONDS
      );
      await program.methods
        .createQuestion(
          "Submit test question",
          answerHashOnChain,
          deadline,
          DEFAULT_DIFFICULTY
        )
        .accountsPartial({
          caller: authority.publicKey,
        })
        .rpc();
    });

    it("sponsor submits valid ZK proof on behalf of user1 and user1 receives instant reward", async () => {
      const pool = await program.account.pool.fetch(poolPda);
      const { proofA, proofB, proofC } = await generateProof(
        snarkjs,
        TEST_ANSWER,
        answerHashStr,
        user1.publicKey,
        pool.round.toString()
      );
      const recordPda = winnerRecordPda(program.programId, user1.publicKey);
      const expectedReward = pool.boostRewardPerWinner.toNumber();

      const user1BalanceBefore = await provider.connection.getBalance(user1.publicKey);

      try {
        await program.methods
          .submitAnswer(proofA, proofB, proofC, TEST_AGENT, TEST_MODEL)
          .accountsPartial({
            user: user1.publicKey,
            payer: sponsor.publicKey,
            wsolMint: NATIVE_MINT,
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ])
          .signers([sponsor])
          .rpc();

        const poolAfter = await program.account.pool.fetch(poolPda);
        expect(poolAfter.boostWinnerCount).to.equal(1);

        const winnerRecord = await program.account.winnerRecord.fetch(recordPda);
        expect(winnerRecord.round.toNumber()).to.equal(pool.round.toNumber());

        const user1BalanceAfter = await provider.connection.getBalance(user1.publicKey);
        const balanceDiff = user1BalanceAfter - user1BalanceBefore;
        expect(balanceDiff).to.equal(expectedReward);

        console.log(
          `    User1 received ${expectedReward / LAMPORTS_PER_SOL} SOL instant reward (1/${pool.boostRewardCount} of total)`
        );
      } catch (err: unknown) {
        if (err && typeof err === "object" && "logs" in err) {
          const logs = (err as { logs: string[] }).logs;
          console.log("    Transaction logs:");
          logs.forEach((log: string) => console.log("      " + log));
        }
        throw err;
      }
    });

    it("sponsor submits valid ZK proof on behalf of user2 (user2 had zero SOL, gets instant reward)", async () => {
      const pool = await program.account.pool.fetch(poolPda);
      const { proofA, proofB, proofC } = await generateProof(
        snarkjs,
        TEST_ANSWER,
        answerHashStr,
        user2.publicKey,
        pool.round.toString()
      );
      const expectedReward = pool.boostRewardPerWinner.toNumber();

      await program.methods
        .submitAnswer(proofA, proofB, proofC, TEST_AGENT, TEST_MODEL)
        .accountsPartial({
          user: user2.publicKey,
          payer: sponsor.publicKey,
          wsolMint: NATIVE_MINT,
        })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ])
        .signers([sponsor])
        .rpc();

      const poolAfter = await program.account.pool.fetch(poolPda);
      expect(poolAfter.boostWinnerCount).to.equal(2);

      const user2Balance = await provider.connection.getBalance(user2.publicKey);
      expect(user2Balance).to.equal(expectedReward);
    });

    it("rejects invalid proof (wrong answer)", async () => {
      const wrongAnswer = "99";
      const pool = await program.account.pool.fetch(poolPda);
      try {
        await generateProof(
          snarkjs,
          wrongAnswer,
          answerHashStr,
          user1.publicKey,
          pool.round.toString()
        );
        expect.fail("should have thrown during proof generation");
      } catch (err) {
        expect(String(err)).to.include("Assert Failed");
      }
    });

    it("rejects proof replay (same user cannot submit twice in same round)", async () => {
      const pool = await program.account.pool.fetch(poolPda);
      const { proofA, proofB, proofC } = await generateProof(
        snarkjs,
        TEST_ANSWER,
        answerHashStr,
        user1.publicKey,
        pool.round.toString()
      );

      try {
        await program.methods
          .submitAnswer(proofA, proofB, proofC, TEST_AGENT, TEST_MODEL)
          .accountsPartial({
            user: user1.publicKey,
            payer: sponsor.publicKey,
            wsolMint: NATIVE_MINT,
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ])
          .signers([sponsor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("AlreadyAnswered");
      }
    });
  });

  describe("pool round and reward_count from previous round", () => {
    it("creates new question, reward_count = max(prev_winner_count, 10)", async () => {
      const poolBefore = await program.account.pool.fetch(poolPda);
      expect(poolBefore.boostWinnerCount).to.equal(2);

      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

      await program.methods
        .createQuestion(
          "New question after round",
          answerHashOnChain,
          deadline,
          DEFAULT_DIFFICULTY
        )
        .accountsPartial({
          caller: authority.publicKey,
        })
        .rpc();

      const pool = await program.account.pool.fetch(poolPda);
      expect(pool.boostWinnerCount).to.equal(0);
      // ±1% rate limit: prev_reward_count=10, target=2, delta=max(0,1)=1 → adjusted=9
      // But min_reward_count=10 clamps it back to 10
      expect(pool.boostRewardCount).to.equal(10);
    });

    it("user1 can answer again in new round (same PDA reused)", async () => {
      const pool = await program.account.pool.fetch(poolPda);
      const { proofA, proofB, proofC } = await generateProof(
        snarkjs,
        TEST_ANSWER,
        answerHashStr,
        user1.publicKey,
        pool.round.toString()
      );

      await program.methods
        .submitAnswer(proofA, proofB, proofC, TEST_AGENT, TEST_MODEL)
        .accountsPartial({
          user: user1.publicKey,
          payer: sponsor.publicKey,
        })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ])
        .signers([sponsor])
        .rpc();

      const poolAfter = await program.account.pool.fetch(poolPda);
      expect(poolAfter.boostWinnerCount).to.equal(1);

      const recordPda = winnerRecordPda(program.programId, user1.publicKey);
      const winnerRecord = await program.account.winnerRecord.fetch(recordPda);
      expect(winnerRecord.round.toNumber()).to.equal(pool.round.toNumber());
    });
  });

  describe("reward_count rate limiting (±1%)", () => {
    before(async () => {
      // Lower min_reward_count to 1 so rate limit effect is visible (not masked by min floor)
      await program.methods
        .setRewardConfig(1, 10000, 10)
        .rpc();
    });

    it("decrease is capped at 1% per round", async () => {
      // State from previous tests: reward_count=10, winner_count=1
      const poolBefore = await program.account.pool.fetch(poolPda);
      expect(poolBefore.boostRewardCount).to.equal(10);
      expect(poolBefore.boostWinnerCount).to.equal(1);

      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
      await program.methods
        .createQuestion(
          "Rate limit decrease test",
          answerHashOnChain,
          deadline,
          DEFAULT_DIFFICULTY
        )
        .accountsPartial({
          caller: authority.publicKey,
        })
        .rpc();

      const pool = await program.account.pool.fetch(poolPda);
      // prev_reward_count=10, target=1, max_delta=max(floor(10*1%)=0,1)=1
      // adjusted = clamp(1, 9, 11) = 9 (not 1!)
      expect(pool.boostRewardCount).to.equal(9);
    });

    it("continues to decrease gradually each round", async () => {
      // State: reward_count=9, winner_count=0 (no one answered)
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
      await program.methods
        .createQuestion(
          "Rate limit decrease test 2",
          answerHashOnChain,
          deadline,
          DEFAULT_DIFFICULTY
        )
        .accountsPartial({
          caller: authority.publicKey,
        })
        .rpc();

      const pool = await program.account.pool.fetch(poolPda);
      // prev_reward_count=9, target=0, max_delta=max(floor(9*1%)=0,1)=1
      // adjusted = clamp(0, 8, 10) = 8
      expect(pool.boostRewardCount).to.equal(8);
    });

    it("min_reward_count floor is still enforced after rate limiting", async () => {
      // Set min_reward_count = 8 (equal to current reward_count)
      await program.methods
        .setRewardConfig(8, 10000, 10)
        .rpc();

      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
      await program.methods
        .createQuestion(
          "Rate limit with min floor test",
          answerHashOnChain,
          deadline,
          DEFAULT_DIFFICULTY
        )
        .accountsPartial({
          caller: authority.publicKey,
        })
        .rpc();

      const pool = await program.account.pool.fetch(poolPda);
      // Rate limit: prev=8, target=0, delta=1 → adjusted=7
      // But min_reward_count=8 clamps it back to 8
      expect(pool.boostRewardCount).to.equal(8);
    });

    after(async () => {
      // Restore original config for subsequent tests
      await program.methods
        .setRewardConfig(10, 16384, 10)
        .rpc();
    });
  });

  describe("transfer_authority", () => {
    it("transfers authority to user1", async () => {
      await program.methods
        .transferAuthority(user1.publicKey)
        .rpc();

      const gameConfig = await program.account.gameConfig.fetch(gameConfigPda);
      expect(gameConfig.authority.toBase58()).to.equal(
        user1.publicKey.toBase58()
      );
    });

    it("old authority can no longer create questions (unless it's quest_authority)", async () => {
      // Set quest_authority to someone else so old authority can't use it
      await program.methods
        .setQuestAuthority(questAuthority.publicKey)
        .accountsPartial({
          authority: user1.publicKey,
        })
        .signers([user1])
        .rpc();

      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
      try {
        await program.methods
          .createQuestion(
            "Should fail",
            answerHashOnChain,
            deadline,
            DEFAULT_DIFFICULTY
          )
          .accountsPartial({
            caller: authority.publicKey,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("Unauthorized");
      }
    });

    it("new authority can create questions", async () => {
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
      await program.methods
        .createQuestion(
          "New authority question",
          answerHashOnChain,
          deadline,
          DEFAULT_DIFFICULTY
        )
        .accountsPartial({
          caller: user1.publicKey,
        })
        .signers([user1])
        .rpc();

      const pool = await program.account.pool.fetch(poolPda);
      expect(pool.question).to.equal("New authority question");
    });

    it("non-authority cannot transfer", async () => {
      try {
        await program.methods
          .transferAuthority(user2.publicKey)
          .accountsPartial({
            authority: user2.publicKey,
          })
          .signers([user2])
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("Unauthorized");
      }
    });

    it("new authority transfers back to original", async () => {
      await program.methods
        .transferAuthority(authority.publicKey)
        .accountsPartial({
          authority: user1.publicKey,
        })
        .signers([user1])
        .rpc();

      const gameConfig = await program.account.gameConfig.fetch(gameConfigPda);
      expect(gameConfig.authority.toBase58()).to.equal(
        authority.publicKey.toBase58()
      );
    });
  });

  describe("set_reward_config", () => {
    it("authority can set reward config", async () => {
      await program.methods
        .setRewardConfig(20, 500, 10)
        .rpc();

      const gameConfig = await program.account.gameConfig.fetch(gameConfigPda);
      expect(gameConfig.minRewardCount).to.equal(20);
      expect(gameConfig.maxRewardCount).to.equal(500);
    });

    it("fails if non-authority tries to set", async () => {
      try {
        await program.methods
          .setRewardConfig(10, 100, 10)
          .accountsPartial({
            authority: user1.publicKey,
          })
          .signers([user1])
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("Unauthorized");
      }
    });

    it("fails if min is 0", async () => {
      try {
        await program.methods
          .setRewardConfig(0, 1000, 10)
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("InvalidMinRewardCount");
      }
    });

    it("fails if min > max", async () => {
      try {
        await program.methods
          .setRewardConfig(2000, 100, 10)
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("InvalidMinRewardCount");
      }
    });

    it("restores default reward config", async () => {
      await program.methods
        .setRewardConfig(10, 1000, 10)
        .rpc();

      const gameConfig = await program.account.gameConfig.fetch(gameConfigPda);
      expect(gameConfig.minRewardCount).to.equal(10);
      expect(gameConfig.maxRewardCount).to.equal(1000);
    });
  });

  describe("set_stake_config", () => {
    it("authority can set stake config", async () => {
      await program.methods
        .setStakeConfig(
          new anchor.BN(200000), // 20x
          new anchor.BN(500),    // 0.05x
          new anchor.BN(10000)
        )
        .rpc();

      const gameConfig = await program.account.gameConfig.fetch(gameConfigPda);
      expect(gameConfig.stakeBpsHigh.toNumber()).to.equal(200000);
      expect(gameConfig.stakeBpsLow.toNumber()).to.equal(500);
      expect(gameConfig.decayMs.toNumber()).to.equal(10000);
    });

    it("fails if non-authority tries to set", async () => {
      try {
        await program.methods
          .setStakeConfig(
            new anchor.BN(50000),
            new anchor.BN(5000),
            new anchor.BN(5)
          )
          .accountsPartial({
            authority: user1.publicKey,
          })
          .signers([user1])
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("Unauthorized");
      }
    });

    it("fails if bps_high is 0", async () => {
      try {
        await program.methods
          .setStakeConfig(
            new anchor.BN(0),
            new anchor.BN(5000),
            new anchor.BN(5)
          )
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("InvalidStakeConfig");
      }
    });

    it("fails if decay_ms is 0", async () => {
      try {
        await program.methods
          .setStakeConfig(
            new anchor.BN(100000),
            new anchor.BN(1000),
            new anchor.BN(0)
          )
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("InvalidStakeConfig");
      }
    });

    it("restores default stake config", async () => {
      await program.methods
        .setStakeConfig(
          new anchor.BN(100000), // 10x
          new anchor.BN(1000),   // 0.1x
          new anchor.BN(2000)
        )
        .rpc();

      const gameConfig = await program.account.gameConfig.fetch(gameConfigPda);
      expect(gameConfig.stakeBpsHigh.toNumber()).to.equal(100000);
      expect(gameConfig.stakeBpsLow.toNumber()).to.equal(1000);
      expect(gameConfig.decayMs.toNumber()).to.equal(2000);
    });
  });

  describe("stake and unstake", () => {
    const stakeAmount = 0.1 * LAMPORTS_PER_SOL;

    function stakeRecordPda(user: PublicKey): PublicKey {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("quest_stake"), user.toBuffer()],
        program.programId
      );
      return pda;
    }

    function stakeTokenAccount(user: PublicKey): PublicKey {
      return getAssociatedTokenAddressSync(
        NATIVE_MINT,
        stakeRecordPda(user),
        true // allowOwnerOffCurve (PDA)
      );
    }

    // Helper: get WSOL balance in stake token account
    async function getStakedAmount(user: PublicKey): Promise<number> {
      const ata = stakeTokenAccount(user);
      const info = await provider.connection.getAccountInfo(ata);
      if (!info) return 0;
      // SPL token account data: amount is at offset 64, 8 bytes LE
      const amount = info.data.readBigUInt64LE(64);
      return Number(amount);
    }

    it("user1 can stake", async () => {
      await program.methods
        .stake(new anchor.BN(stakeAmount))
        .accountsPartial({
          user: user1.publicKey,
          wsolMint: NATIVE_MINT,
        })
        .signers([user1])
        .rpc();

      const staked = await getStakedAmount(user1.publicKey);
      expect(staked).to.equal(stakeAmount);
    });

    it("user1 can stake more (accumulates)", async () => {
      await program.methods
        .stake(new anchor.BN(stakeAmount))
        .accountsPartial({
          user: user1.publicKey,
          wsolMint: NATIVE_MINT,
        })
        .signers([user1])
        .rpc();

      const staked = await getStakedAmount(user1.publicKey);
      expect(staked).to.equal(stakeAmount * 2);
    });

    it("stake zero is a no-op", async () => {
      const stakedBefore = await getStakedAmount(user1.publicKey);

      await program.methods
        .stake(new anchor.BN(0))
        .accountsPartial({
          user: user1.publicKey,
          wsolMint: NATIVE_MINT,
        })
        .signers([user1])
        .rpc();

      const stakedAfter = await getStakedAmount(user1.publicKey);
      expect(stakedAfter).to.equal(stakedBefore);
    });

    it("cannot unstake before round advances", async () => {
      try {
        await program.methods
          .unstake(new anchor.BN(stakeAmount))
          .accountsPartial({
            user: user1.publicKey,
            wsolMint: NATIVE_MINT,
          })
          .signers([user1])
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("UnstakeNotReady");
      }
    });

    it("can unstake after round advances", async () => {
      // Create a new question to advance round
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
      await program.methods
        .createQuestion(
          "Round advance for unstake test",
          answerHashOnChain,
          deadline,
          DEFAULT_DIFFICULTY
        )
        .accountsPartial({
          caller: authority.publicKey,
        })
        .rpc();

      const balanceBefore = await provider.connection.getBalance(user1.publicKey);

      await program.methods
        .unstake(new anchor.BN(stakeAmount))
        .accountsPartial({
          user: user1.publicKey,
          wsolMint: NATIVE_MINT,
        })
        .signers([user1])
        .rpc();

      const staked = await getStakedAmount(user1.publicKey);
      expect(staked).to.equal(stakeAmount); // had 2x, unstaked 1x

      const balanceAfter = await provider.connection.getBalance(user1.publicKey);
      // Balance should increase by stakeAmount minus tx fee
      expect(balanceAfter).to.be.greaterThan(balanceBefore);
    });

    it("fails to unstake more than staked", async () => {
      try {
        await program.methods
          .unstake(new anchor.BN(LAMPORTS_PER_SOL)) // way more than staked
          .accountsPartial({
            user: user1.publicKey,
            wsolMint: NATIVE_MINT,
          })
          .signers([user1])
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("InsufficientStakeBalance");
      }
    });
  });

  describe("treasury insufficient balance", () => {
    it("fails if treasury cannot cover deficit", async () => {
      // Set reward_per_share very high to exceed treasury
      await program.methods
        .setRewardPerShare(
          new anchor.BN(100 * LAMPORTS_PER_SOL), // 100 SOL per share
          new anchor.BN(0)
        )
        .rpc();

      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
      try {
        await program.methods
          .createQuestion(
            "Should fail - insufficient treasury",
            answerHashOnChain,
            deadline,
            DEFAULT_DIFFICULTY
          )
          .accountsPartial({
            caller: authority.publicKey,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("InsufficientTreasury");
      }

      // Restore reward config
      await program.methods
        .setRewardPerShare(
          new anchor.BN(REWARD_PER_SHARE),
          new anchor.BN(EXTRA_REWARD)
        )
        .rpc();
    });
  });

  describe("boost PoMI simulation (20 users)", () => {
    const NUM_USERS = 20;
    const MAX_REWARD = 10;
    const users: Keypair[] = [];

    before(async () => {
      // Set min=max=10 for deterministic slot count
      await program.methods
        .setRewardConfig(MAX_REWARD, MAX_REWARD, 10)
        .rpc();

      // Create 20 users, airdrop SOL, grant 1 credit each
      for (let i = 0; i < NUM_USERS; i++) {
        const kp = Keypair.generate();
        users.push(kp);
        const sig = await provider.connection.requestAirdrop(
          kp.publicKey,
          2 * LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(sig);

        await program.methods
          .adjustFreeStake(1, "boost sim")
          .accountsPartial({
            user: kp.publicKey,
            caller: authority.publicKey,
          })
          .rpc();
      }
    });

    it("round 1: 20 users submit, first 10 get full reward (vault cap at 1 SOL)", async () => {
      // Create question for round 1
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
      await program.methods
        .createQuestion(
          "Staking test round 1",
          answerHashOnChain,
          deadline,
          DEFAULT_DIFFICULTY
        )
        .accountsPartial({
          caller: authority.publicKey,
        })
        .rpc();

      const pool = await program.account.pool.fetch(poolPda);
      expect(pool.boostRewardCount).to.equal(MAX_REWARD);
      // First round after previous tests: stake_high/low should be 0 (no prev avg)
      expect(pool.stakeHigh.toNumber()).to.equal(0);
      expect(pool.stakeLow.toNumber()).to.equal(0);

      // All 20 users submit concurrently with random 0~5s delays
      // Pre-generate proofs (CPU-bound) before launching concurrent submissions
      const proofs: { proofA: number[]; proofB: number[]; proofC: number[] }[] = [];
      for (let i = 0; i < NUM_USERS; i++) {
        proofs.push(await generateProof(
          snarkjs, TEST_ANSWER, answerHashStr,
          users[i].publicKey, pool.round.toString()
        ));
      }

      const balancesBefore = await Promise.all(
        users.map(u => provider.connection.getBalance(u.publicKey))
      );

      // Launch all submissions concurrently, each with independent random delay
      await Promise.all(users.map(async (user, i) => {
        const delay = Math.floor(Math.random() * 5000);
        await sleep(delay);

        await program.methods
          .submitAnswer(proofs[i].proofA, proofs[i].proofB, proofs[i].proofC, TEST_AGENT, TEST_MODEL)
          .accountsPartial({
            user: user.publicKey,
            payer: sponsor.publicKey,
            wsolMint: NATIVE_MINT,
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ])
          .signers([sponsor])
          .rpc();
      }));

      const balancesAfter = await Promise.all(
        users.map(u => provider.connection.getBalance(u.publicKey))
      );

      let rewardedCount = 0;
      for (let i = 0; i < NUM_USERS; i++) {
        if (balancesAfter[i] > balancesBefore[i]) rewardedCount++;
      }

      // Vault = 1 SOL, each reward = 0.1 SOL, so 10 rewarded (vault cap)
      expect(rewardedCount).to.equal(MAX_REWARD);

      const poolAfter = await program.account.pool.fetch(poolPda);
      // All 20 passed the NoCredits check and incremented the winner count
      expect(poolAfter.boostWinnerCount).to.equal(NUM_USERS);

      console.log(`    Round 1: ${rewardedCount}/${NUM_USERS} received reward (vault cap), all submitted`);
    });

    after(async () => {
      // Restore reward config defaults
      await program.methods
        .setRewardConfig(10, 1000, 10)
        .rpc();
    });
  });

  describe("free stake credits", () => {
    const stakeAuthority = Keypair.generate();
    const freeUser = Keypair.generate();

    function stakeRecordPda(user: PublicKey): PublicKey {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("quest_stake"), user.toBuffer()],
        program.programId
      );
      return pda;
    }

    before(async () => {
      // Fund stakeAuthority for gas and init_if_needed rent
      const sig = await provider.connection.requestAirdrop(
        stakeAuthority.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    });

    describe("set_stake_authority", () => {
      it("authority can set stake_authority", async () => {
        await program.methods
          .setStakeAuthority(stakeAuthority.publicKey)
          .rpc();

        const config = await program.account.gameConfig.fetch(gameConfigPda);
        expect(config.stakeAuthority.toBase58()).to.equal(
          stakeAuthority.publicKey.toBase58()
        );
      });

      it("non-authority cannot set stake_authority", async () => {
        try {
          await program.methods
            .setStakeAuthority(freeUser.publicKey)
            .accountsPartial({ authority: user1.publicKey })
            .signers([user1])
            .rpc();
          expect.fail("should have thrown");
        } catch (err) {
          expect(String(err)).to.include("Unauthorized");
        }
      });
    });

    describe("adjust_free_stake", () => {
      it("stake_authority can grant free credits", async () => {
        await program.methods
          .adjustFreeStake(5, "initial grant")
          .accountsPartial({
            user: freeUser.publicKey,
            caller: stakeAuthority.publicKey,
          })
          .signers([stakeAuthority])
          .rpc();

        const record = await program.account.stakeRecord.fetch(
          stakeRecordPda(freeUser.publicKey)
        );
        expect(record.boostCredits).to.equal(5);
      });

      it("stake_authority can reduce free credits", async () => {
        await program.methods
          .adjustFreeStake(-2, "partial revoke")
          .accountsPartial({
            user: freeUser.publicKey,
            caller: stakeAuthority.publicKey,
          })
          .signers([stakeAuthority])
          .rpc();

        const record = await program.account.stakeRecord.fetch(
          stakeRecordPda(freeUser.publicKey)
        );
        expect(record.boostCredits).to.equal(3);
      });

      it("reducing below 0 saturates to 0", async () => {
        await program.methods
          .adjustFreeStake(-100, "over-revoke test")
          .accountsPartial({
            user: freeUser.publicKey,
            caller: stakeAuthority.publicKey,
          })
          .signers([stakeAuthority])
          .rpc();

        const record = await program.account.stakeRecord.fetch(
          stakeRecordPda(freeUser.publicKey)
        );
        expect(record.boostCredits).to.equal(0);
      });

      it("delta=0 fails with InvalidDelta", async () => {
        try {
          await program.methods
            .adjustFreeStake(0, "should fail")
            .accountsPartial({
              user: freeUser.publicKey,
              caller: stakeAuthority.publicKey,
            })
            .signers([stakeAuthority])
            .rpc();
          expect.fail("should have thrown");
        } catch (err) {
          expect(String(err)).to.include("InvalidDelta");
        }
      });

      it("non-stake_authority cannot adjust", async () => {
        try {
          await program.methods
            .adjustFreeStake(1, "unauthorized")
            .accountsPartial({
              user: freeUser.publicKey,
              caller: user1.publicKey,
            })
            .signers([user1])
            .rpc();
          expect.fail("should have thrown");
        } catch (err) {
          expect(String(err)).to.include("Unauthorized");
        }
      });
    });

    describe("submit_answer with free credits", () => {
      before(async () => {
        // Force staking activation: min=max=10
        await program.methods.setRewardConfig(10, 10, 10).rpc();

        // Grant 2 free credits to freeUser
        await program.methods
          .adjustFreeStake(2, "test credits for submit")
          .accountsPartial({
            user: freeUser.publicKey,
            caller: stakeAuthority.publicKey,
          })
          .signers([stakeAuthority])
          .rpc();

        // Ensure treasury has funds
        await fundTreasury(5 * LAMPORTS_PER_SOL);

        // Create question (staking active since reward_count will hit max=10)
        const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
        await program.methods
          .createQuestion(
            "Free stake test question",
            answerHashOnChain,
            deadline,
            DEFAULT_DIFFICULTY
          )
          .accountsPartial({ caller: authority.publicKey })
          .rpc();
      });

      it("user with credits can mine, credit decremented on reward", async () => {
        const pool = await program.account.pool.fetch(poolPda);
        expect(pool.boostRewardCount).to.equal(10);

        const { proofA, proofB, proofC } = await generateProof(
          snarkjs, TEST_ANSWER, answerHashStr,
          freeUser.publicKey, pool.round.toString()
        );

        const balBefore = await provider.connection.getBalance(freeUser.publicKey);

        await program.methods
          .submitAnswer(proofA, proofB, proofC, TEST_AGENT, TEST_MODEL)
          .accountsPartial({
            user: freeUser.publicKey,
            payer: sponsor.publicKey,
            wsolMint: NATIVE_MINT,
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ])
          .signers([sponsor])
          .rpc();

        // Verify reward received
        const balAfter = await provider.connection.getBalance(freeUser.publicKey);
        expect(balAfter).to.be.greaterThan(balBefore);

        // Verify boost_credits decremented: 2 → 1
        const record = await program.account.stakeRecord.fetch(
          stakeRecordPda(freeUser.publicKey)
        );
        expect(record.boostCredits).to.equal(1);
      });

      after(async () => {
        await program.methods.setRewardConfig(10, 1000, 10).rpc();
      });
    });
  });

  describe("airdrop", () => {
    const AIRDROP_AMOUNT = 0.05 * LAMPORTS_PER_SOL;
    const MAX_AIRDROP_COUNT = 3;
    let airdropPda: PublicKey;

    before(async () => {
      [airdropPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("quest_airdrop")],
        program.programId
      );

      // Fund airdrop PDA
      const tx = new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: authority.publicKey,
          toPubkey: airdropPda,
          lamports: 5 * LAMPORTS_PER_SOL,
        })
      );
      await provider.sendAndConfirm(tx);
    });

    describe("set_airdrop_config", () => {
      it("authority can set airdrop config", async () => {
        await program.methods
          .setAirdropConfig(new anchor.BN(AIRDROP_AMOUNT), MAX_AIRDROP_COUNT)
          .rpc();

        const config = await program.account.gameConfig.fetch(gameConfigPda);
        expect(config.airdropAmount.toNumber()).to.equal(AIRDROP_AMOUNT);
        expect(config.maxAirdropCount).to.equal(MAX_AIRDROP_COUNT);
      });

      it("non-authority cannot set airdrop config", async () => {
        try {
          await program.methods
            .setAirdropConfig(new anchor.BN(AIRDROP_AMOUNT), MAX_AIRDROP_COUNT)
            .accountsPartial({ authority: user1.publicKey })
            .signers([user1])
            .rpc();
          expect.fail("should have thrown");
        } catch (err) {
          expect(String(err)).to.include("Unauthorized");
        }
      });
    });

    describe("claim_airdrop", () => {
      before(async () => {
        // Create a question and have user1 answer it
        await fundTreasury(5 * LAMPORTS_PER_SOL);
        const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
        await program.methods
          .createQuestion(
            "Airdrop test question",
            answerHashOnChain,
            deadline,
            DEFAULT_DIFFICULTY
          )
          .accountsPartial({ caller: authority.publicKey })
          .rpc();

        const pool = await program.account.pool.fetch(poolPda);
        const { proofA, proofB, proofC } = await generateProof(
          snarkjs, TEST_ANSWER, answerHashStr,
          user1.publicKey, pool.round.toString()
        );

        await program.methods
          .submitAnswer(proofA, proofB, proofC, TEST_AGENT, TEST_MODEL)
          .accountsPartial({
            user: user1.publicKey,
            payer: sponsor.publicKey,
            wsolMint: NATIVE_MINT,
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ])
          .signers([sponsor])
          .rpc();
      });

      it("user with valid ZK proof can claim airdrop", async () => {
        const pool = await program.account.pool.fetch(poolPda);
        const { proofA, proofB, proofC } = await generateProof(
          snarkjs, TEST_ANSWER, answerHashStr,
          user1.publicKey, pool.round.toString()
        );

        const balBefore = await provider.connection.getBalance(user1.publicKey);

        await program.methods
          .claimAirdrop(proofA, proofB, proofC)
          .accountsPartial({
            user: user1.publicKey,
            payer: sponsor.publicKey,
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ])
          .signers([sponsor])
          .rpc();

        const balAfter = await provider.connection.getBalance(user1.publicKey);
        expect(balAfter - balBefore).to.equal(AIRDROP_AMOUNT);

        const recordPda = winnerRecordPda(program.programId, user1.publicKey);
        const record = await program.account.winnerRecord.fetch(recordPda);
        expect(record.airdropCount).to.equal(1);
        expect(record.lastAirdropTs.toNumber()).to.be.greaterThan(0);
      });

      it("cannot claim again within 24h cooldown (AirdropCooldown)", async () => {
        const pool = await program.account.pool.fetch(poolPda);
        const { proofA, proofB, proofC } = await generateProof(
          snarkjs, TEST_ANSWER, answerHashStr,
          user1.publicKey, pool.round.toString()
        );

        try {
          await program.methods
            .claimAirdrop(proofA, proofB, proofC)
            .accountsPartial({
              user: user1.publicKey,
              payer: sponsor.publicKey,
            })
            .preInstructions([
              ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
            ])
            .signers([sponsor])
            .rpc();
          expect.fail("should have thrown");
        } catch (err) {
          expect(String(err)).to.include("AirdropCooldown");
        }
      });

      it("airdrop disabled when amount=0 (AirdropDisabled)", async () => {
        await program.methods
          .setAirdropConfig(new anchor.BN(0), MAX_AIRDROP_COUNT)
          .rpc();

        const pool = await program.account.pool.fetch(poolPda);
        const { proofA, proofB, proofC } = await generateProof(
          snarkjs, TEST_ANSWER, answerHashStr,
          user1.publicKey, pool.round.toString()
        );

        try {
          await program.methods
            .claimAirdrop(proofA, proofB, proofC)
            .accountsPartial({
              user: user1.publicKey,
              payer: sponsor.publicKey,
            })
            .preInstructions([
              ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
            ])
            .signers([sponsor])
            .rpc();
          expect.fail("should have thrown");
        } catch (err) {
          expect(String(err)).to.include("AirdropDisabled");
        }

        // Re-enable
        await program.methods
          .setAirdropConfig(new anchor.BN(AIRDROP_AMOUNT), MAX_AIRDROP_COUNT)
          .rpc();
      });

      it("new address: claim airdrop first, then submit answer (sponsored gas)", async () => {
        // Restore stake_authority so adjustFreeStake below works
        await program.methods.setStakeAuthority(authority.publicKey).rpc();

        const newUser = Keypair.generate();
        // newUser has 0 SOL — fully sponsored

        const pool = await program.account.pool.fetch(poolPda);

        // Step 1: Claim airdrop first (no prior submit_answer)
        const { proofA, proofB, proofC } = await generateProof(
          snarkjs, TEST_ANSWER, answerHashStr,
          newUser.publicKey, pool.round.toString()
        );

        await program.methods
          .claimAirdrop(proofA, proofB, proofC)
          .accountsPartial({
            user: newUser.publicKey,
            payer: sponsor.publicKey,
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ])
          .signers([sponsor])
          .rpc();

        // Verify airdrop received
        const balAfterAirdrop = await provider.connection.getBalance(newUser.publicKey);
        expect(balAfterAirdrop).to.equal(AIRDROP_AMOUNT);

        // Verify winner_record: airdrop_count=1, round=0 (not set by claim_airdrop)
        const recordPda = winnerRecordPda(program.programId, newUser.publicKey);
        const recordAfterAirdrop = await program.account.winnerRecord.fetch(recordPda);
        expect(recordAfterAirdrop.airdropCount).to.equal(1);
        expect(recordAfterAirdrop.round.toNumber()).to.equal(0); // untouched

        // Step 2: Grant a credit and submit answer (same round, same proof)
        await program.methods
          .adjustFreeStake(1, "airdrop+answer test")
          .accountsPartial({
            user: newUser.publicKey,
            caller: authority.publicKey,
          })
          .rpc();

        await program.methods
          .submitAnswer(proofA, proofB, proofC, TEST_AGENT, TEST_MODEL)
          .accountsPartial({
            user: newUser.publicKey,
            payer: sponsor.publicKey,
            wsolMint: NATIVE_MINT,
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ])
          .signers([sponsor])
          .rpc();

        // Verify answer reward received on top of airdrop
        const balAfterAnswer = await provider.connection.getBalance(newUser.publicKey);
        expect(balAfterAnswer).to.be.greaterThan(balAfterAirdrop);

        // Verify winner_record: round updated, airdrop_count still 1
        const recordAfterAnswer = await program.account.winnerRecord.fetch(recordPda);
        expect(recordAfterAnswer.round.toNumber()).to.equal(pool.round.toNumber());
        expect(recordAfterAnswer.airdropCount).to.equal(1); // unchanged by submit_answer

        console.log(
          `    New user: airdrop=${AIRDROP_AMOUNT / LAMPORTS_PER_SOL} SOL, ` +
          `answer reward=${(balAfterAnswer - balAfterAirdrop) / LAMPORTS_PER_SOL} SOL, ` +
          `total=${balAfterAnswer / LAMPORTS_PER_SOL} SOL`
        );
      });
    });
  });

  describe("boost PoMI", () => {
    const boostUser = Keypair.generate();

    before(async () => {
      // Restore stake_authority to `authority` so adjustFreeStake works below
      await program.methods.setStakeAuthority(authority.publicKey).rpc();
      await program.methods.setRewardConfig(10, 1000, 10).rpc();
      await fundTreasury(5 * LAMPORTS_PER_SOL);

      // Create fresh quest so subsequent submits have a vault
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
      await program.methods
        .createQuestion(
          "boost PoMI test quest",
          answerHashOnChain,
          deadline,
          DEFAULT_DIFFICULTY
        )
        .accountsPartial({ caller: authority.publicKey })
        .rpc();
    });

    it("pool fields: free_* are zero (deprecated), boost_reward_per_winner is pre-split", async () => {
      const pool = await program.account.pool.fetch(poolPda);
      expect(pool.freeRewardCount).to.equal(0);
      expect(pool.freeRewardPerWinner.toNumber()).to.equal(0);
      expect(pool.freeWinnerCount).to.equal(0);
      // Pre-split formula: reward_per_share + extra/reward_count. extra=0 so equals REWARD_PER_SHARE.
      expect(pool.boostRewardPerWinner.toNumber()).to.equal(REWARD_PER_SHARE);
    });

    it("user without credits is rejected (NoCredits)", async () => {
      const pool = await program.account.pool.fetch(poolPda);
      const { proofA, proofB, proofC } = await generateProof(
        snarkjs, TEST_ANSWER, answerHashStr,
        boostUser.publicKey, pool.round.toString()
      );

      try {
        await program.methods
          .submitAnswer(proofA, proofB, proofC, TEST_AGENT, TEST_MODEL)
          .accountsPartial({
            user: boostUser.publicKey,
            payer: sponsor.publicKey,
            wsolMint: NATIVE_MINT,
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ])
          .signers([sponsor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("NoCredits");
      }
    });

    it("user with credit can mine and credit decremented on reward", async () => {
      // Grant 1 credit
      await program.methods
        .adjustFreeStake(1, "boost PoMI test")
        .accountsPartial({
          user: boostUser.publicKey,
          caller: authority.publicKey,
        })
        .rpc();

      const pool = await program.account.pool.fetch(poolPda);
      const { proofA, proofB, proofC } = await generateProof(
        snarkjs, TEST_ANSWER, answerHashStr,
        boostUser.publicKey, pool.round.toString()
      );

      const balBefore = await provider.connection.getBalance(boostUser.publicKey);

      await program.methods
        .submitAnswer(proofA, proofB, proofC, TEST_AGENT, TEST_MODEL)
        .accountsPartial({
          user: boostUser.publicKey,
          payer: sponsor.publicKey,
          wsolMint: NATIVE_MINT,
        })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ])
        .signers([sponsor])
        .rpc();

      const balAfter = await provider.connection.getBalance(boostUser.publicKey);
      expect(balAfter - balBefore).to.equal(pool.boostRewardPerWinner.toNumber());

      // Credit decremented: 1 → 0
      const [stakeRec] = PublicKey.findProgramAddressSync(
        [Buffer.from("quest_stake"), boostUser.publicKey.toBuffer()],
        program.programId,
      );
      const record = await program.account.stakeRecord.fetch(stakeRec);
      expect(record.boostCredits).to.equal(0);
      // user_pubkey was written
      expect(record.userPubkey.toBase58()).to.equal(boostUser.publicKey.toBase58());
    });
  });
});
