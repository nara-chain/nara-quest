import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { NaraQuest } from "../target/types/nara_quest";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
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

  // sponsor: pays gas and rent for submit on behalf of users
  const sponsor = Keypair.generate();

  // user1 and user2 for testing
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

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

    // user2 has zero SOL — fully sponsored
  });

  describe("initialize", () => {
    it("initializes game config and pool", async () => {
      await program.methods
        .initialize()
        .rpc();

      const gameConfig = await program.account.gameConfig.fetch(gameConfigPda);
      expect(gameConfig.authority.toBase58()).to.equal(
        authority.publicKey.toBase58()
      );
      const pool = await program.account.pool.fetch(poolPda);
      expect(pool.round.toNumber()).to.equal(0);
      expect(pool.winnerCount).to.equal(0);
      expect(pool.rewardCount).to.equal(0);
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

  describe("create_question", () => {
    it("creates first question with default reward_count=10", async () => {
      const rewardAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
      const deadline = new anchor.BN(
        Math.floor(Date.now() / 1000) + DEADLINE_SECONDS
      );

      await program.methods
        .createQuestion(
          "What is the answer to life?",
          answerHashOnChain,
          deadline,
          rewardAmount,
          DEFAULT_DIFFICULTY
        )
        .rpc();

      const pool = await program.account.pool.fetch(poolPda);
      expect(pool.round.toNumber()).to.equal(1);
      expect(pool.question).to.equal("What is the answer to life?");
      expect(pool.difficulty).to.equal(DEFAULT_DIFFICULTY);
      expect(pool.winnerCount).to.equal(0);
      expect(pool.rewardCount).to.equal(10);
      expect(pool.rewardAmount.toNumber()).to.equal(1 * LAMPORTS_PER_SOL);
      expect(pool.rewardPerWinner.toNumber()).to.equal(
        Math.floor(1 * LAMPORTS_PER_SOL / 10)
      );
    });

    it("fails if non-authority tries to create question", async () => {
      const rewardAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

      try {
        await program.methods
          .createQuestion(
            "Unauthorized question",
            answerHashOnChain,
            deadline,
            rewardAmount,
            DEFAULT_DIFFICULTY
          )
          .accountsPartial({
            authority: user1.publicKey,
          })
          .signers([user1])
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        // Expected: unauthorized
      }
    });

    it("fails if deadline is in the past", async () => {
      const rewardAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
      const pastDeadline = new anchor.BN(Math.floor(Date.now() / 1000) - 100);

      try {
        await program.methods
          .createQuestion(
            "Past deadline question",
            answerHashOnChain,
            pastDeadline,
            rewardAmount,
            DEFAULT_DIFFICULTY
          )
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("InvalidDeadline");
      }
    });

    it("fails if reward amount is zero", async () => {
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

      try {
        await program.methods
          .createQuestion(
            "Zero reward question",
            answerHashOnChain,
            deadline,
            new anchor.BN(0),
            DEFAULT_DIFFICULTY
          )
          .rpc();
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.include("InsufficientReward");
      }
    });
  });

  describe("submit_answer (instant reward)", () => {
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
      const expectedReward = pool.rewardPerWinner.toNumber();

      const user1BalanceBefore = await provider.connection.getBalance(user1.publicKey);

      try {
        await program.methods
          .submitAnswer(proofA, proofB, proofC, TEST_AGENT, TEST_MODEL)
          .accountsPartial({
            user: user1.publicKey,
            payer: sponsor.publicKey,
          })
          .signers([sponsor])
          .rpc();

        const poolAfter = await program.account.pool.fetch(poolPda);
        expect(poolAfter.winnerCount).to.equal(1);

        const winnerRecord = await program.account.winnerRecord.fetch(recordPda);
        expect(winnerRecord.round.toNumber()).to.equal(pool.round.toNumber());

        const user1BalanceAfter = await provider.connection.getBalance(user1.publicKey);
        const balanceDiff = user1BalanceAfter - user1BalanceBefore;
        expect(balanceDiff).to.equal(expectedReward);

        console.log(
          `    User1 received ${expectedReward / LAMPORTS_PER_SOL} SOL instant reward (1/${pool.rewardCount} of total)`
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
      const expectedReward = pool.rewardPerWinner.toNumber();

      await program.methods
        .submitAnswer(proofA, proofB, proofC, TEST_AGENT, TEST_MODEL)
        .accountsPartial({
          user: user2.publicKey,
          payer: sponsor.publicKey,
        })
        .signers([sponsor])
        .rpc();

      const poolAfter = await program.account.pool.fetch(poolPda);
      expect(poolAfter.winnerCount).to.equal(2);

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
          })
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
      expect(poolBefore.winnerCount).to.equal(2);

      const rewardAmount = new anchor.BN(0.5 * LAMPORTS_PER_SOL);
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

      await program.methods
        .createQuestion(
          "New question after round 1",
          answerHashOnChain,
          deadline,
          rewardAmount,
          DEFAULT_DIFFICULTY
        )
        .rpc();

      const pool = await program.account.pool.fetch(poolPda);
      expect(pool.round.toNumber()).to.equal(2);
      expect(pool.winnerCount).to.equal(0);
      expect(pool.rewardCount).to.equal(10); // max(2, 10) = 10
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
        .signers([sponsor])
        .rpc();

      const poolAfter = await program.account.pool.fetch(poolPda);
      expect(poolAfter.winnerCount).to.equal(1);

      const recordPda = winnerRecordPda(program.programId, user1.publicKey);
      const winnerRecord = await program.account.winnerRecord.fetch(recordPda);
      expect(winnerRecord.round.toNumber()).to.equal(2);
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

    it("old authority can no longer create questions", async () => {
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
      try {
        await program.methods
          .createQuestion(
            "Should fail",
            answerHashOnChain,
            deadline,
            new anchor.BN(LAMPORTS_PER_SOL),
            DEFAULT_DIFFICULTY
          )
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
          new anchor.BN(LAMPORTS_PER_SOL),
          DEFAULT_DIFFICULTY
        )
        .accountsPartial({
          authority: user1.publicKey,
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
});
