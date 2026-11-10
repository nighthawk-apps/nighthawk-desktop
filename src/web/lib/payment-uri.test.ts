import { buildPaymentUri, parsePaymentUri } from "./payment-uri.ts";

const uri = buildPaymentUri("drk1abc", "1.5", "lunch");
const parsed = parsePaymentUri(uri);
if (!parsed || parsed.address !== "drk1abc" || parsed.amount !== "1.5" || parsed.memo !== "lunch") {
  throw new Error(`invoice roundtrip failed: ${uri} -> ${JSON.stringify(parsed)}`);
}

if (buildPaymentUri("drk1abc") !== "drk:drk1abc") {
  throw new Error("bare invoice should omit the query");
}

if (parsePaymentUri(buildPaymentUri("drk1abc", "nope", "x"))?.amount) {
  throw new Error("invalid amount must not survive a roundtrip");
}

console.log("payment-uri.test.ts ok");
