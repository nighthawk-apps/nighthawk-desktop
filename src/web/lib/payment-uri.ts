/** DarkFi payment URI: `drk:<address>?amount=&memo=` (memo is UTF-8, then base64). */

export interface PaymentUri {
  address: string;
  /** Human-readable DRK amount string, if present. */
  amount?: string;
  memo?: string;
}

const MAX_ADDRESS_LENGTH = 256;
/** UnifOMR metadata encodes user-memo length as `u8` (FFI `MAX_PAYMENT_MEMO_BYTES`). */
export const MAX_PAYMENT_MEMO_BYTES = 255;
const MAX_AMOUNT_HUMAN = 21_000_000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function utf8ByteLength(s: string): number {
  return textEncoder.encode(s).length;
}

export function truncateUtf8Bytes(
  s: string,
  maxBytes = MAX_PAYMENT_MEMO_BYTES,
): string {
  const bytes = textEncoder.encode(s);
  if (bytes.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder("utf-8").decode(bytes.subarray(0, end));
}

function decodeBase64Memo(memoParam: string): string | undefined {
  try {
    const bin = atob(memoParam);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
    if (bytes.length > MAX_PAYMENT_MEMO_BYTES) return undefined;
    const text = textDecoder.decode(bytes);
    if ([...text].some((ch) => (ch.codePointAt(0) ?? 0) < 32)) {
      return undefined;
    }
    return text;
  } catch {
    return undefined;
  }
}

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
      memo = decodeBase64Memo(memoParam);
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
