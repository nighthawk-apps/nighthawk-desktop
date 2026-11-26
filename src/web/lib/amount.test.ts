import {
  evaluateSendBalance,
  formatDrkAtomic,
  isValidDrkAmount,
  parseDrkAtomic,
} from "./amount.ts";

// Type-checked compile-time fixtures (tsc --noEmit). Run with:
//   node --experimental-strip-types --test src/web/lib/amount.test.ts
// when using Node 22+, or import from a future test runner.

const cases: Array<[string, bigint]> = [
  ["1", 100_000_000n],
  ["0.18", 18_000_000n],
  ["0.29", 29_000_000n],
  ["0.00000001", 1n],
];

for (const [display, atomic] of cases) {
  const parsed = parseDrkAtomic(display);
  if (parsed !== atomic) {
    throw new Error(`parseDrkAtomic(${display}) = ${parsed}, expected ${atomic}`);
  }
  if (!isValidDrkAmount(display)) {
    throw new Error(`isValidDrkAmount(${display}) should be true`);
  }
}

if (parseDrkAtomic("0.29") === 28999999n) {
  throw new Error("IEEE-754 trap: 0.29 must not become 28999999");
}

if (formatDrkAtomic(18_000_000) !== "0.18") {
  throw new Error(`formatDrkAtomic(18000000) = ${formatDrkAtomic(18_000_000)}`);
}

if (isValidDrkAmount("") || isValidDrkAmount("0") || isValidDrkAmount("1.123456789")) {
  throw new Error("invalid amounts were accepted");
}

const customOk = evaluateSendBalance({
  amountAtomic: 200_000_000n,
  tokenId: "tok_abc",
  tokenAtomic: 250_000_000n,
  drkAtomic: 5_000_000n,
  feeAtomic: 5_000_000n,
});
if (!customOk.ok) throw new Error("custom token with DRK fee should pass");

const unknown = evaluateSendBalance({
  amountAtomic: 1n,
  tokenId: "missing",
  tokenAtomic: null,
  drkAtomic: 50_000_000n,
  feeAtomic: 5_000_000n,
});
if (unknown.ok || unknown.code !== "unknown_token") {
  throw new Error("unknown token must not spend DRK");
}

const feeShort = evaluateSendBalance({
  amountAtomic: 1n,
  tokenId: "tok_abc",
  tokenAtomic: 10n,
  drkAtomic: 1n,
  feeAtomic: 5_000_000n,
});
if (feeShort.ok || feeShort.code !== "insufficient_drk_fee") {
  throw new Error("custom token must require a DRK fee");
}

const drkRow = evaluateSendBalance({
  amountAtomic: 10_000_000n,
  tokenId: "241vANigf1Cy3ytjM1KHXiVECxgxdK4yApddL8KcLssb",
  tokenLabel: "DRK",
  tokenAtomic: 10_000_000n,
  drkAtomic: 10_000_000n,
  feeAtomic: 5_000_000n,
});
if (drkRow.ok || drkRow.code !== "insufficient_drk_amount_and_fee") {
  throw new Error("a DRK portfolio row must reserve the fee");
}
