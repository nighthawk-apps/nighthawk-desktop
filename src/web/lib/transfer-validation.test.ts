import type { LightSyncState, TokenBalance } from "./api.ts";
import { MAX_PAYMENT_MEMO_BYTES, utf8ByteLength } from "./payment-uri.ts";
import {
  DEFAULT_SCHEDULE_FEE_ATOMIC,
  validateFeeEstimate,
  validateSendSubmission,
} from "./transfer-validation.ts";

const ADDR = "fRGoBKrJuxKutPqQVGu6Mpp94uEREg6yDG9MZponXoJ1KzMGEeSAtjxm";

function syncedSnap(overrides: Partial<LightSyncState> = {}): LightSyncState {
  return {
    status: "Synced",
    syncType: "TrialDecrypt",
    statusMessage: "Synced",
    syncTypeMessage: "",
    scannedHeight: 1000,
    chainTip: 1000,
    omrAvailable: false,
    syncMethod: "TrialDecrypt",
    fallbackReason: "None",
    fallbackUserMessage: "",
    protoVersionMismatch: false,
    ...overrides,
  };
}

// 1. Spend-ready gate blocks null / syncing / behind-tip / proto-mismatch
const notReady = validateFeeEstimate({
  sync: syncedSnap({ scannedHeight: 999, chainTip: 1000 }),
  recipient: ADDR,
  amount: "1",
});
if (notReady.ok || notReady.code !== "not_spend_ready") {
  throw new Error(`expected not_spend_ready, got ${JSON.stringify(notReady)}`);
}

const mismatch = validateSendSubmission({
  sync: syncedSnap({ protoVersionMismatch: true }),
  recipient: ADDR,
  amount: "1",
  tokens: [],
  drkBalanceAtomic: 500_000_000,
});
if (mismatch.ok || mismatch.code !== "not_spend_ready") {
  throw new Error(`expected proto mismatch to block send: ${JSON.stringify(mismatch)}`);
}

// 2. Missing recipient & invalid amounts
const missingRecipient = validateFeeEstimate({
  sync: syncedSnap(),
  recipient: "   ",
  amount: "1",
});
if (missingRecipient.ok || missingRecipient.code !== "missing_recipient") {
  throw new Error(`expected missing_recipient, got ${JSON.stringify(missingRecipient)}`);
}

for (const bad of ["", "0", "-1", "1.123456789", "abc", "21000001"]) {
  const res = validateFeeEstimate({
    sync: syncedSnap(),
    recipient: ADDR,
    amount: bad,
  });
  if (res.ok || res.code !== "invalid_amount") {
    throw new Error(`expected invalid_amount for "${bad}", got ${JSON.stringify(res)}`);
  }
}

// 3. Default schedule fee alignment (5_420_000 atomic = 0.0542 DRK)
if (DEFAULT_SCHEDULE_FEE_ATOMIC !== 5_420_000n) {
  throw new Error(`expected DEFAULT_SCHEDULE_FEE_ATOMIC=5420000n, got ${DEFAULT_SCHEDULE_FEE_ATOMIC}`);
}

// 1 DRK + 0.0542 DRK fee = 105_420_000 atomic: 105_000_000 (old 5_000_000 fee) MUST fail
const oldFeeTrap = validateSendSubmission({
  sync: syncedSnap(),
  recipient: ADDR,
  amount: "1",
  tokens: [],
  drkBalanceAtomic: 105_000_000,
});
if (oldFeeTrap.ok || oldFeeTrap.code !== "insufficient_drk_amount_and_fee") {
  throw new Error(`expected insufficient_drk_amount_and_fee for 1.05 DRK balance, got ${JSON.stringify(oldFeeTrap)}`);
}

const exactBalanceOk = validateSendSubmission({
  sync: syncedSnap(),
  recipient: `drk:${ADDR}?amount=1`,
  amount: "1",
  memo: "🚀".repeat(80), // 320 UTF-8 bytes -> must truncate to <= 255 bytes cleanly
  tokens: [],
  drkBalanceAtomic: 105_420_000,
});
if (!exactBalanceOk.ok) {
  throw new Error(`expected exact 1.0542 DRK balance to pass: ${JSON.stringify(exactBalanceOk)}`);
}
if (exactBalanceOk.recipient !== ADDR) {
  throw new Error(`expected drk: URI normalized to bare address, got ${exactBalanceOk.recipient}`);
}
if (!exactBalanceOk.memo || utf8ByteLength(exactBalanceOk.memo) > MAX_PAYMENT_MEMO_BYTES) {
  throw new Error(`memo was not truncated to <= 255 bytes: ${exactBalanceOk.memo?.length}`);
}

// 4. Custom token balance & DRK fee enforcement + Degraded caught-up state allowed
const tokens: TokenBalance[] = [
  { tokenId: "tok_gold", displayLabel: "GOLD", balanceAtomic: 200_000_000 },
];

const customOk = validateSendSubmission({
  sync: syncedSnap({ status: "Degraded" }),
  recipient: ADDR,
  amount: "1.5",
  tokenId: "tok_gold",
  tokens,
  drkBalanceAtomic: 5_420_000,
});
if (!customOk.ok || customOk.amountAtomic !== 150_000_000n) {
  throw new Error(`expected custom token send to pass on Degraded caught-up tip: ${JSON.stringify(customOk)}`);
}

const customLowDrkFee = validateSendSubmission({
  sync: syncedSnap(),
  recipient: ADDR,
  amount: "1.5",
  tokenId: "tok_gold",
  tokens,
  drkBalanceAtomic: 5_000_000,
});
if (customLowDrkFee.ok || customLowDrkFee.code !== "insufficient_drk_fee") {
  throw new Error(`expected insufficient_drk_fee, got ${JSON.stringify(customLowDrkFee)}`);
}

const customLowToken = validateSendSubmission({
  sync: syncedSnap(),
  recipient: ADDR,
  amount: "3",
  tokenId: "tok_gold",
  tokens,
  drkBalanceAtomic: 50_000_000,
});
if (customLowToken.ok || customLowToken.code !== "insufficient_token") {
  throw new Error(`expected insufficient_token, got ${JSON.stringify(customLowToken)}`);
}

const unknownToken = validateSendSubmission({
  sync: syncedSnap(),
  recipient: ADDR,
  amount: "1",
  tokenId: "tok_missing",
  tokens,
  drkBalanceAtomic: 50_000_000,
});
if (unknownToken.ok || unknownToken.code !== "unknown_token") {
  throw new Error(`expected unknown_token, got ${JSON.stringify(unknownToken)}`);
}

// 5. Explicit estimatedFeeAtomic overrides default fee
const customFee = validateSendSubmission({
  sync: syncedSnap(),
  recipient: ADDR,
  amount: "1",
  tokens: [],
  drkBalanceAtomic: 110_000_000,
  estimatedFeeAtomic: 15_000_000,
});
if (customFee.ok || customFee.code !== "insufficient_drk_amount_and_fee") {
  throw new Error(`expected higher estimatedFeeAtomic to reject send: ${JSON.stringify(customFee)}`);
}

console.log("transfer-validation.test.ts ok");
