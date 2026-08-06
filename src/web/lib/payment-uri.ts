/** ZIP-321-style DarkFi payment URI: `drk:<address>?amount=&memo=` (memo base64). */

export interface PaymentUri {
  address: string;
  /** Human-readable DRK amount string, if present. */
  amount?: string;
  memo?: string;
}

const MAX_ADDRESS_LENGTH = 256;
const MAX_MEMO_LENGTH = 512;
const MAX_AMOUNT_HUMAN = 21_000_000;

/**
 * Parse a `drk:` payment URI or a bare address.
 * Returns null if the string is empty / not a usable address.
 */
export function parsePaymentUri(raw: string): PaymentUri | null {
  const input = raw.trim();
  if (!input) return null;

  if (!/^drk:/i.test(input)) {
    if (
      input.length > MAX_ADDRESS_LENGTH ||
      /\s/.test(input) ||
      [...input].some((ch) => ch.charCodeAt(0) < 32)
    ) {
      return null;
    }
    // Bare address paste
    if (input.length >= 16) return { address: input };
    return null;
  }

  try {
    const withoutScheme = input.replace(/^drk:/i, "");
    const q = withoutScheme.indexOf("?");
    const addressRaw = (q >= 0 ? withoutScheme.slice(0, q) : withoutScheme)
      .replace(/^\/\//, "")
      .trim();
    if (
      !addressRaw ||
      addressRaw.length > MAX_ADDRESS_LENGTH ||
      /\s/.test(addressRaw) ||
      [...addressRaw].some((ch) => ch.charCodeAt(0) < 32)
    ) {
      return null;
    }

    const query = q >= 0 ? withoutScheme.slice(q + 1) : "";
    const params = new URLSearchParams(query);

    let amount: string | undefined;
    const amountParam = params.get("amount");
    if (amountParam != null && amountParam !== "") {
      const human = Number(amountParam);
      if (!Number.isFinite(human) || human <= 0 || human > MAX_AMOUNT_HUMAN) {
        return null;
      }
      amount = String(amountParam);
    }

    let memo: string | undefined;
    const memoParam = params.get("memo");
    if (memoParam) {
      try {
        const decoded = atob(memoParam);
        if (
          decoded.length <= MAX_MEMO_LENGTH &&
          ![...decoded].some((ch) => ch.charCodeAt(0) < 32)
        ) {
          memo = decoded;
        }
      } catch {
        /* ignore bad memo */
      }
    }

    return { address: addressRaw, amount, memo };
  } catch {
    return null;
  }
}

/** Apply pasted text: if `drk:` URI, fill fields; else treat as address. */
export function applyRecipientPaste(
  text: string,
): { address: string; amount?: string; memo?: string } | null {
  const parsed = parsePaymentUri(text);
  if (!parsed) return null;
  return parsed;
}
