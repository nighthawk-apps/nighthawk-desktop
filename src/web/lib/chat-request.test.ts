import { prepareInlineChatRequest } from "./chat-request.ts";
import {
  MAX_PAYMENT_MEMO_BYTES,
  parsePaymentUri,
  utf8ByteLength,
} from "./payment-uri.ts";

const ADDR = "fRGoBKrJuxKutPqQVGu6Mpp94uEREg6yDG9MZponXoJ1KzMGEeSAtjxm";

// 1. Valid request with amount + UTF-8 memo round-trips through parsePaymentUri
const full = prepareInlineChatRequest({
  address: `  ${ADDR}  `,
  amount: " 1.25 ",
  memo: "Coffee ☕ for Alice",
});
if (!full.ok) {
  throw new Error(`expected valid request, got ${JSON.stringify(full)}`);
}
const parsedFull = parsePaymentUri(full.uri);
if (
  !parsedFull ||
  parsedFull.address !== ADDR ||
  parsedFull.amount !== "1.25" ||
  parsedFull.memo !== "Coffee ☕ for Alice"
) {
  throw new Error(`round-trip mismatch: ${JSON.stringify(parsedFull)} from ${full.uri}`);
}

// 2. Empty amount & memo are optional (address-only drk: URI)
const bare = prepareInlineChatRequest({
  address: ADDR,
  amount: "   ",
  memo: "",
});
if (!bare.ok || bare.uri !== `drk:${ADDR}` || bare.amount !== undefined || bare.memo !== undefined) {
  throw new Error(`expected bare drk: URI, got ${JSON.stringify(bare)}`);
}

// 3. Invalid amounts rejected
for (const bad of ["0", "-2", "1.123456789", "abc", "21000001"]) {
  const res = prepareInlineChatRequest({
    address: ADDR,
    amount: bad,
    memo: "test",
  });
  if (res.ok || res.code !== "invalid_amount") {
    throw new Error(`expected invalid_amount for "${bad}", got ${JSON.stringify(res)}`);
  }
}

// 4. Missing address rejected
const noAddr = prepareInlineChatRequest({
  address: "  ",
  amount: "1.5",
  memo: "hi",
});
if (noAddr.ok || noAddr.code !== "missing_address") {
  throw new Error(`expected missing_address, got ${JSON.stringify(noAddr)}`);
}

// 5. Oversized multi-byte UTF-8 memo is clamped to <= 255 bytes on valid UTF-8 boundary
const hugeEmojiMemo = "🦀".repeat(100); // 400 bytes -> max 63 emojis = 252 bytes
const clamped = prepareInlineChatRequest({
  address: ADDR,
  amount: "0.5",
  memo: hugeEmojiMemo,
});
if (!clamped.ok || !clamped.memo) {
  throw new Error(`expected clamped memo success: ${JSON.stringify(clamped)}`);
}
const clampedBytes = utf8ByteLength(clamped.memo);
if (clampedBytes > MAX_PAYMENT_MEMO_BYTES || clampedBytes !== 252) {
  throw new Error(`expected 252 UTF-8 bytes (63 * 4B), got ${clampedBytes}`);
}
const parsedClamped = parsePaymentUri(clamped.uri);
if (!parsedClamped || parsedClamped.memo !== clamped.memo) {
  throw new Error(`clamped UTF-8 memo failed URI decode: ${JSON.stringify(parsedClamped)}`);
}

console.log("chat-request.test.ts ok");
