import { formatDrkAtomic, isValidDrkAmount, parseDrkAtomic } from "./amount.ts";

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
