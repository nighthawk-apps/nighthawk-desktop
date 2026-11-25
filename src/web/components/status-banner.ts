import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { t } from "../i18n";

@customElement("status-banner")
export class StatusBanner extends LitElement {
  @property() network = "testnet";
  @property() sync = "";
  @property() mining = "";
  @state() private localeTick = 0;

  private onLocale = () => {
    this.localeTick++;
  };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("nh-locale-changed", this.onLocale);
  }

  override disconnectedCallback() {
    window.removeEventListener("nh-locale-changed", this.onLocale);
    super.disconnectedCallback();
  }

  static styles = css`
    :host {
      display: block;
      padding: 6px 14px;
      background: var(--color-ink-panel);
      border-bottom: 1px solid var(--color-steel-border-muted);
      font-size: var(--font-size-xs);
      color: var(--color-text-muted);
    }
    .row {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
    }
    .pill {
      color: var(--color-accent-muted);
    }
  `;

  render() {
    void this.localeTick;
    const netLabel =
      this.network === "mainnet"
        ? t("network.mainnet")
        : this.network === "testnet"
          ? t("network.testnet")
          : this.network;
    return html`
      <div class="row">
        <span class="pill">${netLabel}</span>
        ${this.sync ? html`<span>${this.sync}</span>` : null}
        ${this.mining ? html`<span>${this.mining}</span>` : null}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "status-banner": StatusBanner;
  }
}
