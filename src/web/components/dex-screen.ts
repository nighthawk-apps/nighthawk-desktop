import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { t } from "../i18n";

@customElement("dex-screen")
export class DexScreen extends LitElement {
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
      display: block;
      padding: 20px;
    }
    h2.screen-title {
      margin: 0 0 13px;
      font-family: var(--font-family-display);
      font-size: var(--font-size-xl);
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--color-text-header);
    }
    .subtitle {
      margin: 0 0 10px;
      font-size: var(--font-size-md);
      color: var(--color-text-muted);
    }
    .body {
      margin: 0;
      font-size: var(--font-size-md);
      color: var(--color-text-body);
      max-width: 36rem;
      line-height: 1.45;
    }
  `;

  render() {
    void this.localeTick;
    return html`
      <h2 class="screen-title">${t("nav.dex")}</h2>
      <p class="subtitle">${t("common.coming_soon")}</p>
      <p class="body">
        The DarkFi DEX will live here. Send, receive, and request stay on Wallet.
      </p>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dex-screen": DexScreen;
  }
}
