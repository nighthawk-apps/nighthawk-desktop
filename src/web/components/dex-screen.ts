import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";

@customElement("dex-screen")
export class DexScreen extends LitElement {
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
    return html`
      <h2 class="screen-title">DEX</h2>
      <p class="subtitle">Coming soon</p>
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
