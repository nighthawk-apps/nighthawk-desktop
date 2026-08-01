import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("app-nav")
export class AppNav extends LitElement {
  @property() active = "wallet";

  static styles = css`
    nav {
      display: flex;
      gap: 4px;
      padding: 8px 12px;
      background: var(--color-charcoal-raised);
      border-top: 1px solid var(--color-steel-border-muted);
    }
    button {
      flex: 1;
      border: none;
      background: transparent;
      color: var(--color-navigation-muted);
      padding: 10px 4px;
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
  `;

  private select(tab: string) {
    this.dispatchEvent(
      new CustomEvent("tab-change", { detail: tab, bubbles: true, composed: true }),
    );
  }

  render() {
    const tabs = [
      ["chat", "Chat"],
      ["wallet", "Wallet"],
      ["transfer", "Transfer"],
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
