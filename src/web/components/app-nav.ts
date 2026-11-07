import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("app-nav")
export class AppNav extends LitElement {
  @property() active = "wallet";

  static styles = css`
    :host {
      font-family: var(--font-family-base);
      font-size: var(--font-size-md);
      line-height: 1.35;
    }
    nav {
      display: flex;
      gap: 4px;
      padding: 10px 12px;
      padding-bottom: max(10px, env(safe-area-inset-bottom, 0px));
      background: var(--color-charcoal-raised);
    }
    button {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: transparent;
      color: var(--color-navigation-muted);
      padding: 10px 4px;
      border-radius: var(--border-radius-md);
      font-size: var(--font-size-md);
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    button.active {
      background: var(--color-accent-subtle-container);
      color: var(--color-accent);
    }
  `;

  private select(tab: string) {
    this.dispatchEvent(
      new CustomEvent("tab-change", { detail: tab, bubbles: true, composed: true }),
    );
  }

  render() {
    // Order: Chat → Wallet → DEX → DAO → Mine → Settings
    // Transfer lives under Wallet (Request / Receive / Send).
    const tabs: Array<[string, string]> = [
      ["chat", "Chat"],
      ["wallet", "Wallet"],
      ["dex", "DEX"],
      ["dao", "DAO"],
      ["mine", "Mine"],
      ["settings", "Settings"],
    ];
    return html`
      <nav>
        ${tabs.map(
          ([id, label]) => html`
            <button
              class=${this.active === id ? "active" : ""}
              @click=${() => this.select(id)}
              title=${label}
            >
              ${label}
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
