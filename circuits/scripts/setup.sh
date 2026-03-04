#!/bin/bash
# Trusted setup script for the answer_proof circuit
# Prerequisites: circom, snarkjs installed globally
#   npm install -g circom snarkjs
#   npm install circomlib (in circuits/ directory)

set -e

CIRCUIT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$CIRCUIT_DIR"

echo "=== Step 1: Compile circuit ==="
circom answer_proof.circom --r1cs --wasm --sym -o build/

echo "=== Step 2: Powers of Tau ceremony ==="
snarkjs powersoftau new bn128 12 build/pot12_0000.ptau -v
snarkjs powersoftau contribute build/pot12_0000.ptau build/pot12_0001.ptau \
  --name="First contribution" -v -e="random entropy string"
snarkjs powersoftau prepare phase2 build/pot12_0001.ptau build/pot12_final.ptau -v

echo "=== Step 3: Circuit-specific setup ==="
snarkjs groth16 setup build/answer_proof.r1cs build/pot12_final.ptau build/answer_proof_0000.zkey
snarkjs zkey contribute build/answer_proof_0000.zkey build/answer_proof_final.zkey \
  --name="First contribution" -v -e="more random entropy"

echo "=== Step 4: Export verification key ==="
snarkjs zkey export verificationkey build/answer_proof_final.zkey build/verification_key.json

echo "=== Step 5: Generate Solana verifying key ==="
echo "Use the groth16-solana parse-vk script to convert verification_key.json"
echo "to Rust constants for embedding in the Solana program."
echo ""
echo "See: https://github.com/Lightprotocol/groth16-solana"
echo "  cd groth16-solana && npm i && npm run parse-vk -- path/to/verification_key.json"

echo ""
echo "=== Setup complete ==="
echo "Artifacts in: $CIRCUIT_DIR/build/"
echo "  - answer_proof.r1cs"
echo "  - answer_proof_js/  (WASM for proof generation)"
echo "  - answer_proof_final.zkey  (proving key)"
echo "  - verification_key.json  (verification key)"
