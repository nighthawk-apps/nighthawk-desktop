/** Parse a human DRK decimal string to atomic units without IEEE-754. */

export const DRK_DECIMALS = 8;
const MAX_DRK_HUMAN = 21_000_000n;

export function parseDrkAtomic(amount: string): bigint | null {
  const trimmed = amount.trim();
  if (!trimmed || !/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [wholeRaw, fracRaw = ""] = trimmed.split(".");
  if (fracRaw.length > DRK_DECIMALS) return null;
  const whole = BigInt(wholeRaw || "0");
  if (whole > MAX_DRK_HUMAN) return null;
  const frac = (fracRaw + "0".repeat(DRK_DECIMALS)).slice(0, DRK_DECIMALS);
  const atomic = whole * 10n ** BigInt(DRK_DECIMALS) + BigInt(frac || "0");
  if (atomic <= 0n) return null;
  return atomic;
}

/** Decimal integer from Tauri. Atomic balances cross IPC as strings so they
 *  stay exact past `Number.MAX_SAFE_INTEGER`. */
export function parseAtomicDecimal(raw: string | bigint): bigint | null {
  if (typeof raw === "bigint") return raw;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return BigInt(trimmed);
}

export function formatDrkAtomic(atomic: number | bigint): string {
  const v = typeof atomic === "bigint" ? atomic : BigInt(Math.trunc(atomic));
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(DRK_DECIMALS);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(DRK_DECIMALS, "0").replace(/0+$/, "");
  const body = frac.length ? `${whole.toString()}.${frac}` : whole.toString();
  return neg ? `-${body}` : body;
}

export function isValidDrkAmount(amount: string): boolean {
  return parseDrkAtomic(amount) !== null;
}

export type SendBalanceCode =
  | "insufficient_drk_amount_and_fee"
  | "unknown_token"
  | "insufficient_token"
  | "insufficient_drk_fee";

export type SendBalance = { ok: true } | { ok: false; code: SendBalanceCode };

/** Same rule as Android: an unknown token id is not DRK, and a custom token
 *  still needs a separate DRK balance for the fee. */
export function evaluateSendBalance(input: {
  amountAtomic: bigint;
  tokenId: string;
  tokenLabel?: string | null;
  tokenAtomic: bigint | null;
  drkAtomic: bigint;
  feeAtomic: bigint;
}): SendBalance {
  const tokenId = input.tokenId.trim();
  const label = (input.tokenLabel ?? "").trim();
  const native =
    !tokenId ||
    tokenId.toUpperCase() === "DRK" ||
    label.toUpperCase() === "DRK";
  if (native) {
    const required = input.amountAtomic + input.feeAtomic;
    if (input.drkAtomic < required) {
      return { ok: false, code: "insufficient_drk_amount_and_fee" };
    }
    return { ok: true };
  }
  if (input.tokenAtomic === null) {
    return { ok: false, code: "unknown_token" };
  }
  if (input.tokenAtomic < input.amountAtomic) {
    return { ok: false, code: "insufficient_token" };
  }
  if (input.drkAtomic < input.feeAtomic) {
    return { ok: false, code: "insufficient_drk_fee" };
  }
  return { ok: true };
}
