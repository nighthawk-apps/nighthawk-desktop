import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { t } from "../i18n";

@customElement("app-nav")
export class AppNav extends LitElement {
  @property() active = "chat";
  @state() private localeTick = 0;

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("nh-locale-changed", this.onLocale);
  }

  disconnectedCallback() {
    window.removeEventListener("nh-locale-changed", this.onLocale);
    super.disconnectedCallback();
  }

  private onLocale = () => {
    this.localeTick++;
  };

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
    void this.localeTick;
    // Order: Chat → Wallet → DEX → DAO → Mine → Settings
    // Transfer lives under Wallet (Request / Receive / Send).
    const tabs: Array<[string, string]> = [
      ["chat", t("nav.chat")],
      ["wallet", t("nav.wallet")],
      ["dex", t("nav.dex")],
      ["dao", t("nav.dao")],
      ["mine", t("nav.mine")],
      ["settings", t("nav.settings")],
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
