/** Lightweight i18n for Nighthawk desktop (Lit). */
import en from "./locales/en.json" with { type: "json" };
import ja from "./locales/ja.json" with { type: "json" };
import zh from "./locales/zh.json" with { type: "json" };
import ko from "./locales/ko.json" with { type: "json" };
import id from "./locales/id.json" with { type: "json" };
import es from "./locales/es.json" with { type: "json" };
import pt from "./locales/pt.json" with { type: "json" };
import ar from "./locales/ar.json" with { type: "json" };

export type LocaleCode = "en" | "ja" | "zh" | "ko" | "id" | "es" | "pt" | "ar";

const catalogs: Record<LocaleCode, Record<string, string>> = {
  en: en as Record<string, string>,
  ja: ja as Record<string, string>,
  zh: zh as Record<string, string>,
  ko: ko as Record<string, string>,
  id: id as Record<string, string>,
  es: es as Record<string, string>,
  pt: pt as Record<string, string>,
  ar: ar as Record<string, string>,
};

const STORAGE_KEY = "nh.locale";

function detectLocale(): LocaleCode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as LocaleCode | null;
    if (saved && saved in catalogs) return saved;
  } catch {
    /* ignore */
  }
  const nav = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase();
  const map: [string, LocaleCode][] = [
    ["ja", "ja"],
    ["zh", "zh"],
    ["ko", "ko"],
    ["id", "id"],
    ["es", "es"],
    ["pt", "pt"],
    ["ar", "ar"],
  ];
  for (const [prefix, code] of map) {
    if (nav.startsWith(prefix)) return code;
  }
  return "en";
}

let current: LocaleCode = detectLocale();

export function getLocale(): LocaleCode {
  return current;
}

export function setLocale(code: LocaleCode): void {
  current = code;
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* ignore */
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = code === "zh" ? "zh-CN" : code;
    document.documentElement.dir = code === "ar" ? "rtl" : "ltr";
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("nh-locale-changed", { detail: code }));
  }
}

/** Translate a key; falls back to English then the key itself. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const cat = catalogs[current] || catalogs.en;
  let s = cat[key] ?? catalogs.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return s;
}

export const supportedLocales: { code: LocaleCode; label: string }[] = [
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
  { code: "ko", label: "한국어" },
  { code: "id", label: "Indonesia" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
  { code: "ar", label: "العربية" },
];

setLocale(current);
