// Generate a proof and output Rust-formatted byte arrays for native testing
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";

const WASM_PATH = "build/answer_proof_js/answer_proof.wasm";
const ZKEY_PATH = "build/answer_proof_final.zkey";

const BN254_FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583"
);

function toBigEndian32(decStr) {
  let hex = BigInt(decStr).toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

function formatRustArray(buf, name, size) {
  const bytes = [...buf];
  let s = `const ${name}: [u8; ${size}] = [\n`;
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    s += "    " + chunk.join(", ") + ",\n";
  }
  s += "];\n";
  return s;
}

async function main() {
  const poseidon = await buildPoseidon();
  const answer = "42";
  const hashRaw = poseidon([BigInt(answer)]);
  const answerHashStr = poseidon.F.toString(hashRaw);

  // Use a fixed pubkey for reproducibility
  const pubkeyHex = "aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd";
  const pubkeyBuf = Buffer.from(pubkeyHex, "hex");
  const lo = BigInt("0x" + pubkeyBuf.subarray(16, 32).toString("hex")).toString();
  const hi = BigInt("0x" + pubkeyBuf.subarray(0, 16).toString("hex")).toString();

  const round = "0"; // test round

  console.log("// answer:", answer);
  console.log("// answer_hash:", answerHashStr);
  console.log("// pubkey:", pubkeyHex);
  console.log("// pubkey_lo:", lo);
  console.log("// pubkey_hi:", hi);
  console.log("// round:", round);
  console.log();

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    { answer, answer_hash: answerHashStr, pubkey_lo: lo, pubkey_hi: hi, round: round },
    WASM_PATH,
    ZKEY_PATH
  );

  // proof_a with negation
  const proofA = Buffer.concat([
    toBigEndian32(proof.pi_a[0]),
    toBigEndian32((BN254_FIELD_MODULUS - BigInt(proof.pi_a[1])).toString()),
  ]);

  // proof_b: EIP-197 format [imag, real, imag, real]
  const proofB = Buffer.concat([
    toBigEndian32(proof.pi_b[0][1]),
    toBigEndian32(proof.pi_b[0][0]),
    toBigEndian32(proof.pi_b[1][1]),
    toBigEndian32(proof.pi_b[1][0]),
  ]);

  // proof_c
  const proofC = Buffer.concat([
    toBigEndian32(proof.pi_c[0]),
    toBigEndian32(proof.pi_c[1]),
  ]);

  // Public inputs as 32-byte BE
  const answerHashBytes = toBigEndian32(answerHashStr);
  const pubkeyLoBytes = Buffer.alloc(32);
  pubkeyBuf.copy(pubkeyLoBytes, 16, 16, 32);
  const pubkeyHiBytes = Buffer.alloc(32);
  pubkeyBuf.copy(pubkeyHiBytes, 16, 0, 16);

  // round as 32-byte BE
  const roundBytes = toBigEndian32(round);

  console.log(formatRustArray(proofA, "PROOF_A", 64));
  console.log(formatRustArray(proofB, "PROOF_B", 128));
  console.log(formatRustArray(proofC, "PROOF_C", 64));
  console.log(formatRustArray(answerHashBytes, "ANSWER_HASH", 32));
  console.log(formatRustArray(pubkeyLoBytes, "PUBKEY_LO", 32));
  console.log(formatRustArray(pubkeyHiBytes, "PUBKEY_HI", 32));
  console.log(formatRustArray(roundBytes, "ROUND", 32));

  process.exit(0);
}

main().catch(console.error);
