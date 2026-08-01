import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("status-banner")
export class StatusBanner extends LitElement {
  @property() network = "testnet";
  @property() sync = "";
  @property() mining = "";

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
    return html`
      <div class="row">
        <span class="pill">${this.network}</span>
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
