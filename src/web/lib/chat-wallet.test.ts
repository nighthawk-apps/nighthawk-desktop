import {
  encodeReceipt,
  findInvoice,
  isClearnetHttp,
  parseReceipt,
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
