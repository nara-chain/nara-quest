// Debug script: generate proof, verify locally with snarkjs, dump byte conversion
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import { readFileSync } from "fs";
import { Keypair } from "@solana/web3.js";

const WASM_PATH = "build/answer_proof_js/answer_proof.wasm";
const ZKEY_PATH = "build/answer_proof_final.zkey";
const VK_PATH = "build/verification_key.json";

const BN254_FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583"
);

function toBigEndian32(decStr) {
  let hex = BigInt(decStr).toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

async function main() {
  // 1. Build Poseidon
  const poseidon = await buildPoseidon();
  const answer = "42";
  const hashRaw = poseidon([BigInt(answer)]);
  const answerHashStr = poseidon.F.toString(hashRaw);
  console.log("Answer hash (decimal):", answerHashStr);
  console.log("Answer hash (hex):", BigInt(answerHashStr).toString(16).padStart(64, "0"));

  // 2. Derive pubkey fields
  const user = Keypair.generate();
  const bytes = user.publicKey.toBuffer();
  const loBuf = bytes.subarray(16, 32);
  const hiBuf = bytes.subarray(0, 16);
  const lo = BigInt("0x" + loBuf.toString("hex")).toString();
  const hi = BigInt("0x" + hiBuf.toString("hex")).toString();

  console.log("\nUser pubkey:", user.publicKey.toBase58());
  console.log("pubkey bytes:", bytes.toString("hex"));
  console.log("pubkey_lo (decimal):", lo);
  console.log("pubkey_hi (decimal):", hi);

  // 3. Generate proof
  console.log("\n=== Generating proof ===");
  const input = {
    answer: answer,
    answer_hash: answerHashStr,
    pubkey_lo: lo,
    pubkey_hi: hi,
  };
  console.log("Circuit input:", JSON.stringify(input, null, 2));

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    WASM_PATH,
    ZKEY_PATH
  );

  console.log("\nPublic signals:", publicSignals);
  console.log("Proof pi_a:", proof.pi_a);
  console.log("Proof pi_b:", proof.pi_b);
  console.log("Proof pi_c:", proof.pi_c);

  // 4. Verify locally with snarkjs
  console.log("\n=== Local verification with snarkjs ===");
  const vk = JSON.parse(readFileSync(VK_PATH, "utf8"));
  const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
  console.log("snarkjs verify result:", valid);

  // 5. Show byte conversion for Solana
  console.log("\n=== Byte conversion for Solana ===");

  // proof_a (with negation)
  const ax = toBigEndian32(proof.pi_a[0]);
  const ay = toBigEndian32(proof.pi_a[1]);
  const ay_neg_val = BN254_FIELD_MODULUS - BigInt(proof.pi_a[1]);
  const ay_neg = toBigEndian32(ay_neg_val.toString());
  console.log("proof_a x:", ax.toString("hex"));
  console.log("proof_a y:", ay.toString("hex"));
  console.log("proof_a y_neg:", ay_neg.toString("hex"));

  // On-chain answer_hash representation
  const answerHashOnChain = toBigEndian32(answerHashStr);
  console.log("\nanswer_hash on-chain:", answerHashOnChain.toString("hex"));

  // On-chain pubkey_lo, pubkey_hi representation
  const pubkeyLoOnChain = Buffer.alloc(32);
  loBuf.copy(pubkeyLoOnChain, 16);
  console.log("pubkey_lo on-chain:", pubkeyLoOnChain.toString("hex"));
  console.log("pubkey_lo as field:", BigInt("0x" + pubkeyLoOnChain.toString("hex")).toString());

  const pubkeyHiOnChain = Buffer.alloc(32);
  hiBuf.copy(pubkeyHiOnChain, 16);
  console.log("pubkey_hi on-chain:", pubkeyHiOnChain.toString("hex"));
  console.log("pubkey_hi as field:", BigInt("0x" + pubkeyHiOnChain.toString("hex")).toString());

  // Verify public input match
  console.log("\n=== Public input match check ===");
  console.log("Signal[0] (answer_hash):", publicSignals[0]);
  console.log("On-chain hash field val:", BigInt("0x" + answerHashOnChain.toString("hex")).toString());
  console.log("Match:", publicSignals[0] === BigInt("0x" + answerHashOnChain.toString("hex")).toString());

  console.log("Signal[1] (pubkey_lo):", publicSignals[1]);
  console.log("On-chain lo field val:", BigInt("0x" + pubkeyLoOnChain.toString("hex")).toString());
  console.log("Match:", publicSignals[1] === BigInt("0x" + pubkeyLoOnChain.toString("hex")).toString());

  console.log("Signal[2] (pubkey_hi):", publicSignals[2]);
  console.log("On-chain hi field val:", BigInt("0x" + pubkeyHiOnChain.toString("hex")).toString());
  console.log("Match:", publicSignals[2] === BigInt("0x" + pubkeyHiOnChain.toString("hex")).toString());

  process.exit(0);
}

main().catch(console.error);
