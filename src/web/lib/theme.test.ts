import { normalizeTheme } from "./theme.ts";

for (const name of ["stealth", "light", "paper", "midnight", "cyberpunk"] as const) {
  if (normalizeTheme(name) !== name) {
    throw new Error(`theme ${name} was not kept`);
  }
}

if (normalizeTheme(null) !== "cyberpunk" || normalizeTheme("nope") !== "cyberpunk") {
  throw new Error("unknown theme must fall back to cyberpunk");
}

console.log("theme.test.ts ok");
