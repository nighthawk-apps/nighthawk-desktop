# Contributing to Nighthawk Desktop

Thank you for your interest in contributing!

## Development Environment Setup

1. Install Rust via `rustup`.
2. Install Node.js (v18+) and `pnpm`.
3. Install Tauri CLI dependencies (macOS: Xcode Command Line Tools).
4. Place sibling checkouts as described in `README.md` (`darkfi-mobile-ffi` next to this repo).

## Project Structure

- `src/web/`: Lit components and CSS theme variables.
- `src-tauri/src/`: Rust backend and gRPC proxy logic.
- `src-tauri/proto/`: Protobuf definitions synced from `darkfi-lightwalletd`.

## Pull Requests

1. Fork the repository and create your branch from `main`.
2. If you've added code that should be tested, add tests.
3. Ensure the test suite passes (`cargo test` and `pnpm test`).
4. Format your code with `cargo fmt` and `prettier`.
5. Issue that pull request!

## UI/UX Guidelines
- All new UI elements **must** use the CSS custom properties defined in `src/web/styles/theme.css`.
- Avoid adding new CSS frameworks or component libraries. Use raw Lit + native CSS.
