export type NighthawkTheme = "stealth" | "paper" | "cyberpunk";

const STORAGE_KEY = "nighthawk-theme";

export function currentTheme(): NighthawkTheme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "stealth" || stored === "paper" || stored === "cyberpunk") return stored;
  // No saved choice: Cyberpunk for a light or a dark system theme.
  return "cyberpunk";
}

export function applyTheme(theme: NighthawkTheme) {
  if (theme === "stealth") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
  localStorage.setItem(STORAGE_KEY, theme);
}

applyTheme(currentTheme());
