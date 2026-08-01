# Nighthawk Desktop Theme Porting Guide

This document describes how the Android color theme from `nighthawk-android-wallet`
was mapped into the desktop web environment for Nighthawk Desktop.

## Source

The desktop app relies on the `DarkColorPalette` / `StealthTokens` definitions from the
Android design library (sibling checkout), for example:

`../nighthawk-android-wallet/ui-design-lib/src/main/java/com/nighthawkapps/lib/android/ui/design/theme/internal/Color.kt`

## Methodology

We map Android Jetpack Compose Material 3 color definitions directly to standard CSS custom properties.

| Android Token | CSS Variable | Hex Code |
| ------------- | ------------ | -------- |
| `primaryButton` (`accent`) | `--nh-dark-primary` | `#5E9BAF` |
| `textPrimaryButton` (`onAccent`) | `--nh-dark-on-primary` | `#081018` |
| `primaryContainer` (`accentSubtleContainer`) | `--nh-dark-primary-container` | `#243038` |
| `onPrimaryContainer` (`textHeader`) | `--nh-dark-on-primary-container` | `#E8EBEF` |
| `secondaryButton` (`secondaryFill`) | `--nh-dark-secondary` | `#252D36` |
| `textSecondaryButton` (`textBody`) | `--nh-dark-on-secondary` | `#C4CBD4` |
| `backgroundStart` (`moonlit`) | `--nh-dark-background` | `#0E1012` |
| `surface` (`charcoalRaised`) | `--nh-dark-surface` | `#171C22` |
| `surfaceVariant` (`elevated`) | `--nh-dark-surface-variant` | `#1F252D` |
| `outline` (`steelBorder`) | `--nh-dark-outline` | `#343D47` |
| `dangerous` | `--nh-dark-error` | `#CF6679` |
| `onDangerous` | `--nh-dark-on-error` | `#1C1B1F` |

## Usage

In Lit elements, access these properties using standard CSS `var()` declarations. Example:

```css
:host {
    background-color: var(--nh-background);
    color: var(--nh-on-background);
}
.button {
    background-color: var(--nh-primary);
    color: var(--nh-on-primary);
}
```

The primary CSS definitions are located at `src/web/styles/theme.css` and are automatically imported in `index.html`. No JavaScript is required for theme bootstrapping unless dynamic light/dark toggling is requested in the future.
