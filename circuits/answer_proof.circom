pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";

// ZK circuit for proving knowledge of a quiz answer
// Public inputs: answer_hash, pubkey_lo, pubkey_hi
// Private inputs: answer
//
// The circuit proves that:
//   Poseidon(answer) == answer_hash
//
// pubkey_lo and pubkey_hi bind the proof to a specific user's public key,
// preventing proof replay attacks between different users.

template AnswerProof() {
    // Private input: the actual answer (as a field element, max 31 bytes)
    signal input answer;

    // Public inputs
    signal input answer_hash;   // Poseidon(correct_answer), stored on-chain
    signal input pubkey_lo;     // Lower 128 bits of user's Solana pubkey
    signal input pubkey_hi;     // Upper 128 bits of user's Solana pubkey

    // Constraint: Poseidon(answer) must equal the stored answer_hash
    component hasher = Poseidon(1);
    hasher.inputs[0] <== answer;
    answer_hash === hasher.out;

    // Bind proof to user's pubkey (these are public inputs, so they
    // automatically participate in the Groth16 verification equation).
    // A dummy constraint is needed to prevent circom from optimizing them away.
    signal pubkey_bind;
    pubkey_bind <== pubkey_lo * pubkey_hi;
}

component main {public [answer_hash, pubkey_lo, pubkey_hi]} = AnswerProof();
