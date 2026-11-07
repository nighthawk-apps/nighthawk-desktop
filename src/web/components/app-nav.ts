import { LitElement, html, css, svg } from "lit";
import { customElement, property } from "lit/decorators.js";

/** DAO Hub icon — Material Icons "groups" (Apache-2.0) https://fonts.google.com/icons */
const daoHubIcon = svg`
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
    <path
      fill="currentColor"
      d="M12 12.75c1.63 0 3.07.39 4.24.94 1.08.5 1.76 1.56 1.76 2.73V18H6v-1.58c0-1.17.68-2.23 1.76-2.73 1.17-.55 2.61-.94 4.24-.94zM4 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm1.13 1.1c-.37.14-.73.31-1.06.53C2.85 15.31 2 16.5 2 17.75V19h3.5v-1.58c0-.85.33-1.62.87-2.23-.31-.1-.63-.18-.99-.26zM20 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm-.87 1.1c.37.14.73.31 1.06.53.72.42 1.56 1.61 1.56 2.86V19h-3.5v-1.58c0-.85-.33-1.62-.87-2.23.31-.1.63-.18.99-.26zM12 6c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z"
    />
  </svg>
`;

@customElement("app-nav")
export class AppNav extends LitElement {
  @property() active = "wallet";

  static styles = css`
    :host {
      font-family: var(--font-family-base);
      font-size: var(--font-size-sm);
      line-height: 1.35;
    }
    nav {
      display: flex;
      gap: 4px;
      padding: 8px 12px;
      padding-bottom: max(8px, env(safe-area-inset-bottom, 0px));
      background: var(--color-charcoal-raised);
    }
    button {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      border: none;
      background: transparent;
      color: var(--color-navigation-muted);
      padding: 8px 4px;
      border-radius: var(--border-radius-md);
      font-size: var(--font-size-xs);
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    button.active {
      background: var(--color-accent-subtle-container);
      color: var(--color-accent);
    }
    button svg {
      display: block;
    }
  `;

  private select(tab: string) {
    this.dispatchEvent(
      new CustomEvent("tab-change", { detail: tab, bubbles: true, composed: true }),
    );
  }

  render() {
    // Order: Chat → Wallet → Transfer (Dex) → DAO Hub → Mine → Settings
    const tabs: Array<[string, string, unknown?]> = [
      ["chat", "Chat"],
      ["wallet", "Wallet"],
      ["transfer", "Transfer"],
      ["dao", "DAO", daoHubIcon],
      ["mine", "Mine"],
      ["settings", "Settings"],
    ];
    return html`
      <nav>
        ${tabs.map(
          ([id, label, icon]) => html`
            <button
              class=${this.active === id ? "active" : ""}
              @click=${() => this.select(id)}
              title=${label}
            >
              ${icon ?? null}
              <span>${label}</span>
            </button>
          `,
        )}
      </nav>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "app-nav": AppNav;
  }
}
