import { parsePaymentUri, type PaymentUri } from "./payment-uri.ts";

export interface ChatInvoice extends PaymentUri {
  raw: string;
}

export type ReceiptPhase = "pending" | "broadcasted" | "confirmed" | "failed";

export interface ChatReceipt {
  id: string;
  phase: ReceiptPhase;
  amount: string;
  address: string;
  memo?: string;
  txId?: string;
}

const RECEIPT_PREFIX = "nh-receipt:v1";

export function findInvoice(text: string): ChatInvoice | null {
  for (const token of text.split(/\s+/)) {
    const raw = token.replace(/[.,;)]+$/, "");
    if (!/^drk:/i.test(raw)) continue;
    const parsed = parsePaymentUri(raw);
    if (!parsed?.address) continue;
    return { raw, ...parsed };
  }
  return null;
}

export function encodeReceipt(receipt: ChatReceipt): string {
  const memo = receipt.memo?.trim()
    ? btoa(unescape(encodeURIComponent(receipt.memo)))
    : "-";
  const tx = receipt.txId?.trim() || "-";
  return [
    RECEIPT_PREFIX,
    receipt.phase,
    receipt.id.replaceAll("|", ""),
    receipt.amount.replaceAll("|", ""),
    receipt.address.replaceAll("|", ""),
    memo,
    tx,
  ].join("|");
}

export function parseReceipt(text: string): ChatReceipt | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(`${RECEIPT_PREFIX}|`)) return null;
  const parts = trimmed.split("|");
  if (parts.length < 7) return null;
  const phase = parts[1] as ReceiptPhase;
  if (!["pending", "broadcasted", "confirmed", "failed"].includes(phase)) return null;
  let memo: string | undefined;
  if (parts[5] !== "-") {
    try {
      memo = decodeURIComponent(escape(atob(parts[5])));
    } catch {
      memo = undefined;
    }
  }
  const tx = parts[6] && parts[6] !== "-" ? parts[6] : undefined;
  return {
    id: parts[2],
    phase,
    amount: parts[3],
    address: parts[4],
    memo,
    txId: tx,
  };
}

export function isClearnetHttp(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://");
}

export const CHAT_PAY_URI_KEY = "nighthawk.chatPayUri";
