import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import QRCode from "qrcode";
import { api, formatInvokeError } from "../lib/api";
import { t } from "../i18n";

@customElement("receive-flow")
export class ReceiveFlow extends LitElement {
  @state() private address = "";
  @state() private addresses: string[] = [];
  @state() private qr = "";
  @state() private copied = false;
  @state() private error = "";
  @state() private localeTick = 0;

  private onLocale = () => {
    this.localeTick++;
  };

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
      transition: background-color var(--transition-fast, 0.2s);
    }
    button.secondary {
      background: var(--color-secondary-fill);
      color: var(--color-text-header);
      border: 1px solid var(--color-steel-border);
    }
    .err {
      color: var(--color-dangerous);
      font-size: var(--font-size-sm);
      margin-top: 8px;
    }
    .saved-list {
      margin-top: 14px;
      border-top: 1px solid var(--color-steel-border-muted);
      padding-top: 10px;
    }
    .saved-title {
      font-size: var(--font-size-xs);
      color: var(--color-text-muted);
      margin-bottom: 6px;
    }
    .saved-item {
      display: block;
      width: 100%;
      text-align: left;
      margin: 4px 0 0;
      padding: 6px 8px;
      font-size: var(--font-size-xs);
      font-weight: 400;
      word-break: break-all;
      background: var(--color-elevated);
      color: var(--color-text-body);
      border: 1px solid var(--color-steel-border-muted);
    }
    .saved-item.selected {
      border-color: var(--color-accent);
      color: var(--color-accent-muted);
    }
  `;

  async connectedCallback() {
    super.connectedCallback();
    window.addEventListener("nh-locale-changed", this.onLocale);
    try {
      this.address = await api.walletAddress();
      this.addresses = await api.walletAddresses().catch(() =>
        this.address ? [this.address] : [],
      );
      this.qr = await QRCode.toDataURL(this.address, { margin: 1, width: 180 });
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  override disconnectedCallback() {
    window.removeEventListener("nh-locale-changed", this.onLocale);
    super.disconnectedCallback();
  }

  private async selectAddr(addr: string) {
    this.address = addr;
    this.copied = false;
    this.qr = await QRCode.toDataURL(addr, { margin: 1, width: 180 });
  }

  private copyAddress() {
    if (!this.address) return;
    navigator.clipboard.writeText(this.address);
    this.copied = true;
    setTimeout(() => {
      this.copied = false;
    }, 2000);
  }

  private async newAddr() {
    this.error = "";
    try {
      this.address = await api.generateAddress();
      this.addresses = await api.walletAddresses().catch(() =>
        this.addresses.includes(this.address)
          ? this.addresses
          : [this.address, ...this.addresses],
      );
      this.qr = await QRCode.toDataURL(this.address, { margin: 1, width: 180 });
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  render() {
    void this.localeTick;
    return html`
      <div class="card">
        <div class="addr">${this.address || t("wallet.loading_address")}</div>
        ${this.qr ? html`<img src=${this.qr} alt="QR Code" />` : null}
        <div>
          <button @click=${this.copyAddress}>
            ${this.copied ? t("common.copied_bang") : t("wallet.copy_address")}
          </button>
          <button class="secondary" @click=${this.newAddr}>
            ${t("wallet.new_address")}
          </button>
        </div>
        ${this.addresses.length > 1
          ? html`
              <div class="saved-list">
                <div class="saved-title">
                  ${t("wallet.saved_addresses", { count: this.addresses.length })}
                </div>
                ${this.addresses.map(
                  (addr) => html`
                    <button
                      class="saved-item ${addr === this.address ? "selected" : ""}"
                      @click=${() => this.selectAddr(addr)}
                    >
                      ${addr}
                    </button>
                  `,
                )}
              </div>
            `
          : null}
        ${this.error ? html`<div class="err">${this.error}</div>` : null}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "receive-flow": ReceiveFlow;
  }
}
