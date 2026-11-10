export type NighthawkTheme = "stealth" | "light" | "paper" | "midnight" | "cyberpunk";

const STORAGE_KEY = "nighthawk-theme";

export function normalizeTheme(stored: string | null): NighthawkTheme {
  if (
    stored === "stealth" ||
    stored === "light" ||
    stored === "paper" ||
    stored === "midnight" ||
    stored === "cyberpunk"
  ) {
    return stored;
  }
  // No saved choice: Cyberpunk for a light or a dark system theme.
  return "cyberpunk";
}

export function currentTheme(): NighthawkTheme {
  return normalizeTheme(localStorage.getItem(STORAGE_KEY));
}

export function applyTheme(theme: NighthawkTheme) {
  if (theme === "stealth") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
  localStorage.setItem(STORAGE_KEY, theme);
}

if (typeof localStorage !== "undefined") {
  applyTheme(currentTheme());
}
