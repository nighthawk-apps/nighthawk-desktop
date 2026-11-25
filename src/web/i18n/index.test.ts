import { getLocale, setLocale, supportedLocales, t } from "./index.ts";

if (supportedLocales.length < 8) {
  throw new Error(`expected at least 8 locales, got ${supportedLocales.length}`);
}

setLocale("en");
if (getLocale() !== "en") throw new Error("setLocale('en') failed");
if (t("nav.wallet") !== "Wallet") throw new Error(`unexpected en nav.wallet: ${t("nav.wallet")}`);
if (t("nonexistent.key") !== "nonexistent.key") {
  throw new Error("missing key should return key itself");
}

setLocale("ja");
if (getLocale() !== "ja") throw new Error("setLocale('ja') failed");
if (!t("nav.settings") || t("nav.settings") === "nav.settings") {
  throw new Error("ja translation missing for nav.settings");
}

setLocale("ar");
if (getLocale() !== "ar") throw new Error("setLocale('ar') failed");
if (!t("nav.chat") || t("nav.chat") === "nav.chat") {
  throw new Error("ar translation missing for nav.chat");
}

// Interpolation works on fallback key string as well
if (t("Hello {name} #{n}", { name: "Nighthawk", n: 3 }) !== "Hello Nighthawk #3") {
  throw new Error("interpolation failed");
}

// Restore English for deterministic post-state
setLocale("en");
console.log("i18n/index.test.ts ok");
