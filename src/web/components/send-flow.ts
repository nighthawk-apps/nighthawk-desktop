import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import jsQR from "jsqr";
import {
  api,
  type AddressBookEntry,
  type TokenBalance,
} from "../lib/api";
import {
  applyRecipientPaste,
  MAX_PAYMENT_MEMO_BYTES,
  truncateUtf8Bytes,
  utf8ByteLength,
} from "../lib/payment-uri";

@customElement("send-flow")
export class SendFlow extends LitElement {
  @state() private recipient = "";
  @state() private amount = "";
  @state() private memo = "";
  @state() private tokenId = "";
  @state() private tokens: TokenBalance[] = [];
  @state() private book: AddressBookEntry[] = [];
  @state() private fee: number | null = null;
  @state() private result = "";
  @state() private error = "";
  @state() private busy = false;
  @state() private saveLabel = "";
  @state() private scanHint = "";

  static styles = css`
    label {
      display: block;
      margin-top: 12px;
      font-size: var(--font-size-sm);
      color: var(--color-text-muted);
    }
    input,
    textarea,
    select {
      width: 100%;
      box-sizing: border-box;
      margin-top: 6px;
      padding: 12px;
      border-radius: var(--border-radius-md);
      border: 1px solid var(--color-steel-border);
      background: var(--color-elevated);
      color: var(--color-text-header);
      font-family: inherit;
    }
    .row {
      display: flex;
      gap: 8px;
      margin-top: 16px;
    }
    .row.tight {
      margin-top: 8px;
    }
    button {
      flex: 1;
      padding: 12px;
      border: none;
      border-radius: var(--border-radius-md);
      background: var(--color-accent);
      color: var(--color-on-accent);
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    button.secondary {
      background: var(--color-secondary-fill);
      color: var(--color-text-header);
    }
    .msg {
      margin-top: 12px;
      font-size: var(--font-size-sm);
    }
    .err {
      color: var(--color-dangerous);
    }
    .ok {
      color: var(--color-accent-muted);
      word-break: break-all;
    }
    .hint {
      color: var(--color-text-muted);
      font-size: var(--font-size-xs);
      margin-top: 6px;
    }
    .tiers {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    .tiers button {
      font-size: var(--font-size-xs);
      padding: 8px;
    }
    .tiers button.active {
      outline: 2px solid var(--color-accent);
    }
    input[type="file"] {
      display: none;
    }
  `;

  async connectedCallback() {
    super.connectedCallback();
    try {
      this.tokens = await api.listTokenBalances();
      this.book = await api.addressBookList();
    } catch {
      /* wallet may still be settling */
    }
  }

  private applyParsed(parsed: {
    address: string;
    amount?: string;
    memo?: string;
  }) {
    this.recipient = parsed.address;
    if (parsed.amount) this.amount = parsed.amount;
    if (parsed.memo) this.memo = truncateUtf8Bytes(parsed.memo);
    this.scanHint = parsed.amount || parsed.memo
      ? "Filled from payment URI"
      : "Address filled";
  }

  private onRecipientInput(e: Event) {
    const v = (e.target as HTMLInputElement).value;
    // Live-detect drk: URIs as the user pastes
    if (/^drk:/i.test(v.trim())) {
      const parsed = applyRecipientPaste(v);
      if (parsed) {
        this.applyParsed(parsed);
        return;
      }
    }
    this.recipient = v;
  }

  private onRecipientPaste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData("text") ?? "";
    if (!/^drk:/i.test(text.trim())) return;
    const parsed = applyRecipientPaste(text);
    if (!parsed) return;
    e.preventDefault();
    this.applyParsed(parsed);
  }

  private async onQrFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    this.error = "";
    this.scanHint = "Scanning…";
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable");
      ctx.drawImage(bitmap, 0, 0);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height);
      if (!code?.data) {
        this.scanHint = "";
        this.error = "No QR code found in image";
        return;
      }
      const parsed = applyRecipientPaste(code.data);
      if (!parsed) {
        // Raw QR payload that isn't a drk: URI — use as address if plausible
        if (code.data.trim().length >= 16 && !/\s/.test(code.data.trim())) {
          this.recipient = code.data.trim();
          this.scanHint = "Address filled from QR";
          return;
        }
        this.error = "QR did not contain a payment address";
        this.scanHint = "";
        return;
      }
      this.applyParsed(parsed);
    } catch (err: any) {
      this.scanHint = "";
      this.error = String(err);
    }
  }

  private async estimate() {
    this.error = "";
    try {
      this.fee = await api.estimateFee({
        recipient: this.recipient.trim(),
        amount: this.amount.trim(),
        memo: this.memo || undefined,
        tokenId: this.tokenId || undefined,
      });
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async send() {
    this.error = "";
    this.result = "";
    const parsedPreview = applyRecipientPaste(this.recipient);
    const dest = (parsedPreview?.address ?? this.recipient).trim();
    if (
      !confirm(
        `Send ${this.amount.trim()} to ${dest}? This cannot be undone.`,
      )
    ) {
      return;
    }
    this.busy = true;
    try {
      // Allow pasting a drk: URI into recipient at send time
      const parsed = applyRecipientPaste(this.recipient);
      if (parsed && /^drk:/i.test(this.recipient.trim())) {
        this.applyParsed(parsed);
      }
      this.result = await api.sendDrk({
        recipient: this.recipient.trim(),
        amount: this.amount.trim(),
        memo: this.memo || undefined,
        tokenId: this.tokenId || undefined,
      });
    } catch (e: any) {
      this.error = String(e);
    } finally {
      this.busy = false;
    }
  }

  private async saveContact() {
    if (!this.recipient.trim() || !this.saveLabel.trim()) return;
    try {
      this.book = await api.addressBookUpsert({
        id: `c${Date.now()}`,
        label: this.saveLabel.trim(),
        address: this.recipient.trim(),
        notes: "",
      });
      this.saveLabel = "";
    } catch (e: any) {
      this.error = String(e);
    }
  }

  render() {
    return html`
      <label>Address book</label>
      <select
        @change=${(e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          if (v) this.recipient = v;
        }}
      >
        <option value="">Select contact…</option>
        ${this.book.map(
          (c) => html`<option value=${c.address}>${c.label}</option>`,
        )}
      </select>
      <label>Recipient address or <code>drk:</code> URI</label>
      <input
        .value=${this.recipient}
        placeholder="Paste address or drk:…?amount=&memo="
        @input=${this.onRecipientInput}
        @paste=${this.onRecipientPaste}
      />
      <div class="row tight">
        <input
          placeholder="Save as label"
          .value=${this.saveLabel}
          @input=${(e: Event) =>
            (this.saveLabel = (e.target as HTMLInputElement).value)}
        />
        <button class="secondary" @click=${this.saveContact}>Save</button>
        <button
          class="secondary"
          @click=${() =>
            this.shadowRoot?.querySelector<HTMLInputElement>("#qr-file")?.click()}
        >
          Scan QR image
        </button>
        <input
          id="qr-file"
          type="file"
          accept="image/*"
          @change=${this.onQrFile}
        />
      </div>
      ${this.scanHint ? html`<p class="hint">${this.scanHint}</p>` : null}
      <label>Token</label>
      <select
        .value=${this.tokenId}
        @change=${(e: Event) =>
          (this.tokenId = (e.target as HTMLSelectElement).value)}
      >
        <option value="">DRK (native)</option>
        ${this.tokens.map(
          (t) => html`
            <option value=${t.tokenId}>
              ${t.displayLabel || t.tokenId.slice(0, 12)}…
              (${(t.balanceAtomic / 1e8).toFixed(4)})
            </option>
          `,
        )}
      </select>
      <label>Amount</label>
      <input
        .value=${this.amount}
        @input=${(e: Event) =>
          (this.amount = (e.target as HTMLInputElement).value)}
      />
      <label>Memo (optional, ${utf8ByteLength(this.memo)}/${MAX_PAYMENT_MEMO_BYTES} UTF-8 bytes)</label>
      <textarea
        rows="2"
        .value=${this.memo}
        @input=${(e: Event) =>
          (this.memo = truncateUtf8Bytes(
            (e.target as HTMLTextAreaElement).value,
          ))}
      ></textarea>
      ${this.fee !== null
        ? html`<p class="msg">
            Estimated fee: ${(this.fee / 1e8).toFixed(8)} DRK
          </p>`
        : null}
      <div class="row">
        <button class="secondary" @click=${this.estimate}>Estimate fee</button>
        <button ?disabled=${this.busy} @click=${this.send}>
          ${this.busy ? "Sending…" : "Send"}
        </button>
      </div>
      ${this.result ? html`<p class="msg ok">Tx: ${this.result}</p>` : null}
      ${this.error ? html`<p class="msg err">${this.error}</p>` : null}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "send-flow": SendFlow;
  }
}
