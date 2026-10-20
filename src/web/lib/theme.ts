export type NighthawkTheme = "stealth" | "paper";

const STORAGE_KEY = "nighthawk-theme";

export function currentTheme(): NighthawkTheme {
  return localStorage.getItem(STORAGE_KEY) === "paper" ? "paper" : "stealth";
}

export function applyTheme(theme: NighthawkTheme) {
  if (theme === "paper") {
    document.documentElement.dataset.theme = "paper";
  } else {
    delete document.documentElement.dataset.theme;
  }
  localStorage.setItem(STORAGE_KEY, theme);
}

applyTheme(currentTheme());
