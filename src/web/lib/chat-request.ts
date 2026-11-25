import { isValidDrkAmount } from "./amount.ts";
import {
  buildPaymentUri,
  MAX_PAYMENT_MEMO_BYTES,
  truncateUtf8Bytes,
} from "./payment-uri.ts";

export type InlineChatRequestErrorCode = "invalid_amount" | "missing_address";

export type InlineChatRequestResult =
  | {
      ok: true;
      uri: string;
      amount?: string;
      memo?: string;
    }
  | {
      ok: false;
      code: InlineChatRequestErrorCode;
    };

/**
 * Pure validation & URI builder for the inline Chat Request modal.
 * - `amount` is optional; when provided, must be a positive DRK decimal with <= 8 fractional digits.
 * - `memo` is optional; clamped cleanly to `MAX_PAYMENT_MEMO_BYTES` (255 UTF-8 bytes) without splitting code points.
 * - `address` must be non-empty.
 */
export function prepareInlineChatRequest(input: {
  address: string;
  amount: string;
  memo: string;
}): InlineChatRequestResult {
  const amt = input.amount.trim();
  if (amt && !isValidDrkAmount(amt)) {
    return { ok: false, code: "invalid_amount" };
  }
  const address = input.address.trim();
  if (!address) {
    return { ok: false, code: "missing_address" };
  }
  const clampedMemo = truncateUtf8Bytes(input.memo, MAX_PAYMENT_MEMO_BYTES).trim();
  const uri = buildPaymentUri(
    address,
    amt || undefined,
    clampedMemo || undefined,
  );
  return {
    ok: true,
    uri,
    amount: amt || undefined,
    memo: clampedMemo || undefined,
  };
}
