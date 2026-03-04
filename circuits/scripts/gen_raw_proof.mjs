// Generate a proof and output bytes in the same format as groth16-solana test:
// - proof_a: NOT negated (big-endian x || big-endian y)
// - proof_b: EIP-197 format
// - proof_c: big-endian x || big-endian y
// Also output the JavaScript-negated proof_a for comparison

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
  let s = `    const ${name}: [u8; ${size}] = [\n`;
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    s += "        " + chunk.join(", ") + ",\n";
  }
  s += "    ];\n";
  return s;
}

async function main() {
  const poseidon = await buildPoseidon();
  const answer = "42";
  const hashRaw = poseidon([BigInt(answer)]);
  const answerHashStr = poseidon.F.toString(hashRaw);

  // Use a fixed pubkey for reproducibility
  const pubkeyHex =
    "aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd";
  const pubkeyBuf = Buffer.from(pubkeyHex, "hex");
  const lo = BigInt(
    "0x" + pubkeyBuf.subarray(16, 32).toString("hex")
  ).toString();
  const hi = BigInt(
    "0x" + pubkeyBuf.subarray(0, 16).toString("hex")
  ).toString();

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    { answer, answer_hash: answerHashStr, pubkey_lo: lo, pubkey_hi: hi },
    WASM_PATH,
    ZKEY_PATH
  );

  console.log("// answer:", answer);
  console.log("// answer_hash:", answerHashStr);
  console.log("// pubkey:", pubkeyHex);
  console.log("// pubkey_lo:", lo);
  console.log("// pubkey_hi:", hi);
  console.log("// publicSignals:", JSON.stringify(publicSignals));
  console.log("//");
  console.log("// proof.pi_a:", JSON.stringify(proof.pi_a));
  console.log("// proof.pi_b:", JSON.stringify(proof.pi_b));
  console.log("// proof.pi_c:", JSON.stringify(proof.pi_c));
  console.log();

  // NON-NEGATED proof_a (same as groth16-solana test format)
  const proofA_raw = Buffer.concat([
    toBigEndian32(proof.pi_a[0]),
    toBigEndian32(proof.pi_a[1]),
  ]);

  // JS-NEGATED proof_a (our current approach)
  const proofA_neg = Buffer.concat([
    toBigEndian32(proof.pi_a[0]),
    toBigEndian32(
      (BN254_FIELD_MODULUS - BigInt(proof.pi_a[1])).toString()
    ),
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

  // Output as a complete Rust test
  console.log("// Paste this into submit_answer.rs #[cfg(test)] mod tests {}");
  console.log("");
  console.log("    #[test]");
  console.log("    fn test_proof_raw_format() {");
  console.log(
    "        use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};"
  );
  console.log("        use crate::constants::*;");
  console.log("");
  console.log("        const TEST_VK: Groth16Verifyingkey = Groth16Verifyingkey {");
  console.log("            nr_pubinputs: 3,");
  console.log("            vk_alpha_g1: VK_ALPHA_G1,");
  console.log("            vk_beta_g2: VK_BETA_G2,");
  console.log("            vk_gamme_g2: VK_GAMMA_G2,");
  console.log("            vk_delta_g2: VK_DELTA_G2,");
  console.log("            vk_ic: &VK_IC,");
  console.log("        };");
  console.log("");

  // Raw proof_a (non-negated) for Rust arkworks negation
  console.log(
    "        // Non-negated proof_a (Rust will negate with arkworks)"
  );
  console.log(formatRustArray(proofA_raw, "PROOF_A_RAW", 64));

  // JS-negated proof_a
  console.log("        // JS-negated proof_a (our current approach)");
  console.log(formatRustArray(proofA_neg, "PROOF_A_NEG", 64));

  console.log(formatRustArray(proofB, "PROOF_B", 128));
  console.log(formatRustArray(proofC, "PROOF_C", 64));

  console.log("        // Public inputs");
  console.log(formatRustArray(answerHashBytes, "ANSWER_HASH", 32));
  console.log(formatRustArray(pubkeyLoBytes, "PUBKEY_LO", 32));
  console.log(formatRustArray(pubkeyHiBytes, "PUBKEY_HI", 32));

  console.log("        let public_inputs: [[u8; 32]; 3] = [ANSWER_HASH, PUBKEY_LO, PUBKEY_HI];");
  console.log("");
  console.log("        // Test 1: JS-negated proof_a (our current approach)");
  console.log("        let mut verifier = Groth16Verifier::new(");
  console.log("            &PROOF_A_NEG, &PROOF_B, &PROOF_C,");
  console.log("            &public_inputs, &TEST_VK,");
  console.log('        ).expect("new should succeed");');
  console.log('        let result = verifier.verify();');
  console.log('        println!("JS-negated result: {:?}", result);');
  console.log("");
  console.log("        // Test 2: Raw proof_a (let's also try without negation)");
  console.log("        let mut verifier2 = Groth16Verifier::new(");
  console.log("            &PROOF_A_RAW, &PROOF_B, &PROOF_C,");
  console.log("            &public_inputs, &TEST_VK,");
  console.log('        ).expect("new should succeed");');
  console.log('        let result2 = verifier2.verify();');
  console.log('        println!("Raw (non-negated) result: {:?}", result2);');
  console.log("");
  console.log("        // At least one should succeed");
  console.log('        assert!(result.is_ok() || result2.is_ok(), "Both negated and non-negated failed!");');
  console.log("    }");

  // Also output decimal values for manual verification
  console.log("");
  console.log("// === Decimal values for reference ===");
  console.log("// pi_a[0] =", proof.pi_a[0]);
  console.log("// pi_a[1] =", proof.pi_a[1]);
  console.log(
    "// pi_a[1] negated =",
    (BN254_FIELD_MODULUS - BigInt(proof.pi_a[1])).toString()
  );
  console.log("// pi_b[0] = [", proof.pi_b[0][0], ",", proof.pi_b[0][1], "]");
  console.log("// pi_b[1] = [", proof.pi_b[1][0], ",", proof.pi_b[1][1], "]");
  console.log("// pi_c[0] =", proof.pi_c[0]);
  console.log("// pi_c[1] =", proof.pi_c[1]);

  process.exit(0);
}

main().catch(console.error);
