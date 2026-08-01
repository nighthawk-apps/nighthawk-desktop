import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import QRCode from "qrcode";
import { api } from "../lib/api";

@customElement("receive-flow")
export class ReceiveFlow extends LitElement {
  @state() private address = "";
  @state() private qr = "";

  static styles = css`
    .card {
      background: var(--color-charcoal-raised);
      border: 1px solid var(--color-steel-border-muted);
      border-radius: var(--border-radius-lg);
      padding: 16px;
    }
    .addr {
      word-break: break-all;
      font-size: var(--font-size-sm);
      color: var(--color-accent-muted);
    }
    img {
      width: 180px;
      height: 180px;
      margin: 16px 0;
      background: #fff;
      padding: 8px;
      border-radius: 8px;
    }
    button {
      background: var(--color-accent);
      color: var(--color-on-accent);
      border: none;
      border-radius: var(--border-radius-md);
      padding: 10px 16px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      margin-right: 8px;
    }
  `;

  async connectedCallback() {
    super.connectedCallback();
    this.address = await api.walletAddress();
    this.qr = await QRCode.toDataURL(this.address, { margin: 1, width: 180 });
  }

  private async newAddr() {
    this.address = await api.generateAddress();
    this.qr = await QRCode.toDataURL(this.address, { margin: 1, width: 180 });
  }

  render() {
    return html`
      <div class="card">
        <div class="addr">${this.address}</div>
        ${this.qr ? html`<img src=${this.qr} alt="QR" />` : null}
        <div>
          <button @click=${() => navigator.clipboard.writeText(this.address)}>
            Copy
          </button>
          <button @click=${this.newAddr}>New address</button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "receive-flow": ReceiveFlow;
  }
}
