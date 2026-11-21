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

export type SendBalance =
  | { ok: true }
  | { ok: false; reason: string };

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
      return { ok: false, reason: "Not enough DRK for the amount and fee" };
    }
    return { ok: true };
  }
  if (input.tokenAtomic === null) {
    return { ok: false, reason: "That token is not in this wallet" };
  }
  if (input.tokenAtomic < input.amountAtomic) {
    return { ok: false, reason: "Not enough of the selected token" };
  }
  if (input.drkAtomic < input.feeAtomic) {
    return { ok: false, reason: "Not enough DRK to pay the fee" };
  }
  return { ok: true };
}
