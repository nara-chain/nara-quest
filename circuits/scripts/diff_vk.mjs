import { readFileSync } from "fs";

const official = readFileSync("verifying_key.rs", "utf8");
const constants = readFileSync("programs/nara-quest/src/constants.rs", "utf8");

// Extract all numbers from a text block
function extractAllNumbers(text) {
  return text.match(/\d+/g).map(Number);
}

// Extract named array
function getBlock(text, startMarker) {
  const idx = text.indexOf(startMarker);
  if (idx === -1) return null;
  const open = text.indexOf("[", idx);
  let depth = 0;
  let end = open;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "[") depth++;
    if (text[i] === "]") depth--;
    if (depth === 0) { end = i; break; }
  }
  return text.substring(open, end + 1);
}

const pairs = [
  ["vk_alpha_g1:", "VK_ALPHA_G1:"],
  ["vk_beta_g2:", "VK_BETA_G2:"],
  ["vk_gamme_g2:", "VK_GAMMA_G2:"],
  ["vk_delta_g2:", "VK_DELTA_G2:"],
  ["vk_ic:", "VK_IC:"],
];

for (const [offKey, ourKey] of pairs) {
  const offBlock = getBlock(official, offKey);
  const ourBlock = getBlock(constants, ourKey);
  if (!offBlock || !ourBlock) {
    console.log(`${ourKey} - could not find block`);
    continue;
  }
  const offNums = extractAllNumbers(offBlock);
  const ourNums = extractAllNumbers(ourBlock);

  // For VK_IC, skip the first number (which is the size in [u8; 64]; 4])
  let offStart = 0;
  let ourStart = ourKey === "VK_IC:" ? 2 : 0; // skip "64" and "4" in [[u8; 64]; 4]

  const offArr = offNums.slice(offStart);
  const ourArr = ourNums.slice(ourStart);

  let diffs = 0;
  const len = Math.max(offArr.length, ourArr.length);
  for (let i = 0; i < len; i++) {
    if (offArr[i] !== ourArr[i]) {
      console.log(`${ourKey} diff at byte ${i}: official=${offArr[i]} ours=${ourArr[i]}`);
      diffs++;
    }
  }
  if (diffs === 0) {
    console.log(`${ourKey} OK (${offArr.length} bytes, no diffs)`);
  } else {
    console.log(`${ourKey} has ${diffs} differences!`);
  }
}
