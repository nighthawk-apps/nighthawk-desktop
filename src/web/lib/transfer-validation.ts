import {
  evaluateSendBalance,
  isValidDrkAmount,
  parseAtomicDecimal,
  parseDrkAtomic,
} from "./amount.ts";
import { spendReady, type LightSyncState, type TokenBalance } from "./api.ts";
import {
  applyRecipientPaste,
  MAX_PAYMENT_MEMO_BYTES,
  truncateUtf8Bytes,
} from "./payment-uri.ts";

/** Matches `blackhawk::transactions::SCHEDULE_TRANSFER_FEE_ATOMIC` (0.0542 DRK). */
export const DEFAULT_SCHEDULE_FEE_ATOMIC = 5_420_000n;

export type SendValidationErrorCode =
  | "not_spend_ready"
  | "missing_recipient"
  | "invalid_amount"
  | "insufficient_drk_amount_and_fee"
  | "unknown_token"
  | "insufficient_token"
  | "insufficient_drk_fee";

export type FeeEstimateValidation =
  | { ok: true; recipient: string; amount: string; memo?: string; tokenId?: string }
  | { ok: false; code: SendValidationErrorCode };

export type SendSubmissionValidation =
  | {
      ok: true;
      recipient: string;
      amount: string;
      amountAtomic: bigint;
      memo?: string;
      tokenId?: string;
      feeAtomic: bigint;
    }
  | { ok: false; code: SendValidationErrorCode };

export function validateFeeEstimate(input: {
  sync: LightSyncState | null;
  recipient: string;
  amount: string;
  memo?: string;
  tokenId?: string;
}): FeeEstimateValidation {
  if (!spendReady(input.sync)) {
    return { ok: false, code: "not_spend_ready" };
  }
  const rawRecipient = input.recipient.trim();
  const parsed = applyRecipientPaste(rawRecipient);
  const recipient = (parsed?.address ?? rawRecipient).trim();
  if (!recipient) {
    return { ok: false, code: "missing_recipient" };
  }
  const amount = input.amount.trim();
  if (!isValidDrkAmount(amount)) {
    return { ok: false, code: "invalid_amount" };
  }
  const memoClean = input.memo
    ? truncateUtf8Bytes(input.memo, MAX_PAYMENT_MEMO_BYTES)
    : "";
  const tokenId = input.tokenId?.trim() || undefined;
  return {
    ok: true,
    recipient,
    amount,
    memo: memoClean || undefined,
    tokenId,
  };
}

export function validateSendSubmission(input: {
  sync: LightSyncState | null;
  recipient: string;
  amount: string;
  memo?: string;
  tokenId?: string;
  tokens: TokenBalance[];
  drkBalanceAtomic: string | bigint;
  estimatedFeeAtomic?: number | bigint | null;
}): SendSubmissionValidation {
  const base = validateFeeEstimate(input);
  if (!base.ok) return base;

  const amountAtomic = parseDrkAtomic(base.amount);
  if (amountAtomic === null) {
    return { ok: false, code: "invalid_amount" };
  }

  const feeAtomic =
    input.estimatedFeeAtomic != null
      ? typeof input.estimatedFeeAtomic === "bigint"
        ? input.estimatedFeeAtomic
        : BigInt(Math.trunc(input.estimatedFeeAtomic))
      : DEFAULT_SCHEDULE_FEE_ATOMIC;
  const drkAtomic = parseAtomicDecimal(input.drkBalanceAtomic);
  if (drkAtomic === null) {
    return { ok: false, code: "invalid_amount" };
  }

  const tokenId = base.tokenId ?? "";
  const token = tokenId
    ? input.tokens.find((t) => t.tokenId === tokenId)
    : undefined;
  let tokenAtomic: bigint | null = null;
  if (tokenId && token) {
    const parsed = parseAtomicDecimal(token.balanceAtomic);
    if (parsed === null) {
      return { ok: false, code: "invalid_amount" };
    }
    tokenAtomic = parsed;
  }
  const check = evaluateSendBalance({
    amountAtomic,
    tokenId,
    tokenLabel: token?.displayLabel,
    tokenAtomic,
    drkAtomic,
    feeAtomic,
  });

  if (!check.ok) {
    switch (check.code) {
      case "insufficient_drk_amount_and_fee":
      case "unknown_token":
      case "insufficient_token":
      case "insufficient_drk_fee":
        return { ok: false, code: check.code };
      default: {
        const unexpected: never = check.code;
        return unexpected;
      }
    }
  }

  return {
    ok: true,
    recipient: base.recipient,
    amount: base.amount,
    amountAtomic,
    memo: base.memo,
    tokenId: base.tokenId,
    feeAtomic,
  };
}
