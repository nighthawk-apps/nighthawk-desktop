import {
  CHAT_PAY_CONTEXT_KEY,
  CHAT_PAY_URI_KEY,
  consumeChatPayContext,
  encodeReceipt,
  encodeReceiptForChat,
  findInvoice,
  isClearnetHttp,
  parseReceipt,
  stageChatPayContext,
} from "./chat-wallet.ts";

const invoice = findInvoice("pay me drk:fRGoBKrJuxKutPqQVGu6Mpp94uEREg6yDG9MZponXoJ1KzMGEeSAtjxm?amount=1");
if (!invoice || !invoice.address.startsWith("fRGo") || invoice.amount !== "1") {
  throw new Error(`invoice parse failed ${JSON.stringify(invoice)}`);
}

const encoded = encodeReceipt({
  id: "r1",
  phase: "pending",
  amount: "2",
  address: "addr",
  memo: "lunch",
});
const parsed = parseReceipt(encoded);
if (!parsed || parsed.phase !== "pending" || parsed.memo !== "lunch" || parsed.amount !== "2") {
  throw new Error(`receipt round trip failed ${JSON.stringify(parsed)}`);
}

if (!isClearnetHttp("https://dark.fi/docs") || isClearnetHttp("fud://abc")) {
  throw new Error("clearnet guard mismatch");
}

const mem = new Map<string, string>();
const store = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
stageChatPayContext(
  {
    raw: "drk:addr1?amount=1",
    channel: "#nighthawk",
    dmMode: false,
    receiptId: "r-99",
  },
  store,
);
if (!mem.get(CHAT_PAY_URI_KEY) || !mem.get(CHAT_PAY_CONTEXT_KEY)) {
  throw new Error("expected staged chat pay URI and context");
}
const consumed = consumeChatPayContext(store);
if (
  !consumed ||
  consumed.raw !== "drk:addr1?amount=1" ||
  consumed.context?.channel !== "#nighthawk" ||
  consumed.context?.receiptId !== "r-99" ||
  mem.size !== 0
) {
  throw new Error(`unexpected consumed context: ${JSON.stringify(consumed)}`);
}

const compact = encodeReceiptForChat({
  id: "r-big",
  phase: "broadcasted",
  amount: "5",
  address: "fRGoBKrJuxKutPqQVGu6Mpp94uEREg6yDG9MZponXoJ1KzMGEeSAtjxm",
  memo: "x".repeat(400),
  txId: "a".repeat(64),
});
const compactParsed = parseReceipt(compact);
if (!compactParsed || compactParsed.memo !== undefined || compactParsed.txId !== "a".repeat(64)) {
  throw new Error(`expected long memo stripped to fit 512B limit: ${compact}`);
}
