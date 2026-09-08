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
