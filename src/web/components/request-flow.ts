import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import QRCode from "qrcode";
import { api } from "../lib/api";
import {
  buildPaymentUri,
  MAX_PAYMENT_MEMO_BYTES,
  truncateUtf8Bytes,
  utf8ByteLength,
} from "../lib/payment-uri";
import { isValidDrkAmount } from "../lib/amount";

@customElement("request-flow")
export class RequestFlow extends LitElement {
  @state() private address = "";
  @state() private amount = "";
  @state() private memo = "";
  @state() private qr = "";
  @state() private copied = false;
  @state() private error = "";

  static styles = css`
    label {
      display: block;
      margin-top: 12px;
      color: var(--color-text-muted);
      font-size: var(--font-size-sm);
    }
    input,
    textarea {
      width: 100%;
      margin-top: 4px;
      padding: 10px 12px;
      border-radius: var(--border-radius-md);
      border: 1px solid var(--color-steel-border);
      background: var(--color-charcoal-deep);
      color: var(--color-text-header);
      font-family: inherit;
    }
    img {
      width: 180px;
      height: 180px;
      margin: 16px 0;
      background: #fff;
      padding: 8px;
      border-radius: 8px;
    }
    .invoice {
      word-break: break-all;
      font-size: var(--font-size-sm);
      color: var(--color-accent-muted);
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
      margin-top: 12px;
    }
    .err {
      color: var(--color-dangerous);
    }
  `;

  override async connectedCallback() {
    super.connectedCallback();
    try {
      this.address = await api.walletAddress();
      await this.refreshQr();
    } catch (e: unknown) {
      this.error = String(e);
    }
  }

  private invoice(): string {
    return buildPaymentUri(this.address, this.amount, this.memo);
  }

  private async refreshQr() {
    if (!this.address) return;
    if (this.amount.trim() && !isValidDrkAmount(this.amount.trim())) {
      this.error = "Enter a valid DRK amount (up to 8 decimal places)";
      this.qr = "";
      return;
    }
    this.error = "";
    this.qr = await QRCode.toDataURL(this.invoice(), { margin: 1, width: 180 });
  }

  private async onAmount(e: Event) {
    this.amount = (e.target as HTMLInputElement).value;
    await this.refreshQr();
  }

  private async onMemo(e: Event) {
    this.memo = truncateUtf8Bytes((e.target as HTMLTextAreaElement).value);
    await this.refreshQr();
  }

  private copy() {
    navigator.clipboard.writeText(this.invoice());
    this.copied = true;
    setTimeout(() => {
      this.copied = false;
    }, 2000);
  }

  override render() {
    return html`
      <p>One receive address. The QR is a drk: invoice.</p>
      <label>Amount</label>
      <input .value=${this.amount} placeholder="0.0" @input=${this.onAmount} />
      <label>Memo (${utf8ByteLength(this.memo)}/${MAX_PAYMENT_MEMO_BYTES} UTF-8 bytes)</label>
      <textarea rows="2" .value=${this.memo} @input=${this.onMemo}></textarea>
      ${this.qr ? html`<img alt="Payment request" src=${this.qr} />` : null}
      <p class="invoice">${this.invoice()}</p>
      <button @click=${this.copy}>${this.copied ? "Copied" : "Copy invoice"}</button>
      ${this.error ? html`<p class="err">${this.error}</p>` : null}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "request-flow": RequestFlow;
  }
}
