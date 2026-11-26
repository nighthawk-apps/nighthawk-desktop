import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import jsQR from "jsqr";
import {
  api,
  formatInvokeError,
  spendReady,
  type AddressBookEntry,
  type LightSyncState,
  type TokenBalance,
} from "../lib/api";
import { formatDrkAtomic, parseAtomicDecimal } from "../lib/amount";
import {
  applyRecipientPaste,
  MAX_PAYMENT_MEMO_BYTES,
  truncateUtf8Bytes,
  utf8ByteLength,
} from "../lib/payment-uri";
import {
  CHAT_RECEIPT_EVENT,
  consumeChatPayContext,
  encodeReceiptForChat,
  type ChatPayContext,
  type ChatReceipt,
  type ChatReceiptDetail,
} from "../lib/chat-wallet";
import {
  validateFeeEstimate,
  validateSendSubmission,
  type SendValidationErrorCode,
} from "../lib/transfer-validation";
import { t } from "../i18n";

function sendErrorText(code: SendValidationErrorCode): string {
  switch (code) {
    case "not_spend_ready":
      return t("send.wait_error");
    case "missing_recipient":
      return t("wallet.recipient_required");
    case "invalid_amount":
      return t("send.invalid_amount");
    case "insufficient_drk_amount_and_fee":
      return t("send.err_not_enough_drk");
    case "unknown_token":
      return t("send.err_unknown_token");
    case "insufficient_token":
      return t("send.err_not_enough_token");
    case "insufficient_drk_fee":
      return t("send.err_not_enough_drk_fee");
  }
}

@customElement("send-flow")
export class SendFlow extends LitElement {
  @state() private recipient = "";
  @state() private amount = "";
  @state() private memo = "";
  @state() private tokenId = "";
  @state() private tokens: TokenBalance[] = [];
  @state() private book: AddressBookEntry[] = [];
  @state() private selectedContactId = "";
  @state() private fee: number | null = null;
  @state() private result = "";
  @state() private error = "";
  @state() private busy = false;
  @state() private saveLabel = "";
  @state() private scanHint = "";
  @state() private sync: LightSyncState | null = null;
  @state() private localeTick = 0;
  private chatPayContext: ChatPayContext | null = null;
  private onShellSync = (e: Event) => {
    const snap = (e as CustomEvent<LightSyncState>).detail;
    if (snap) this.sync = snap;
  };
  private onLocale = () => {
    this.localeTick++;
  };

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
      align-items: stretch;
    }
    .row.tight select {
      margin-top: 0;
      flex: 1;
    }
    .row.tight button.compact {
      flex: 0 0 auto;
      padding: 10px 12px;
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
    button.danger {
      background: var(--color-dangerous-banner-bg);
      color: var(--color-dangerous-banner-fg);
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

  override async connectedCallback() {
    super.connectedCallback();
    window.addEventListener("nh-locale-changed", this.onLocale);
    const staged = consumeChatPayContext();
    if (staged) {
      const parsed = applyRecipientPaste(staged.raw);
      if (parsed) this.applyParsed(parsed);
      this.chatPayContext = staged.context ?? {
        raw: staged.raw,
        channel: "",
        dmMode: false,
        receiptId: `r-${Date.now()}`,
      };
    }
    void this.pollSync();
    window.addEventListener("nighthawk-sync-updated", this.onShellSync);
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
    this.scanHint =
      parsed.amount || parsed.memo
        ? t("send.filled_from_uri")
        : t("send.address_filled");
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
    this.scanHint = t("send.scanning_qr");
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error(t("send.canvas_unavailable"));
      ctx.drawImage(bitmap, 0, 0);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height);
      if (!code?.data) {
        this.scanHint = "";
        this.error = t("send.qr_not_found");
        return;
      }
      const parsed = applyRecipientPaste(code.data);
      if (!parsed) {
        // Raw QR payload that isn't a drk: URI — use as address if plausible
        if (code.data.trim().length >= 16 && !/\s/.test(code.data.trim())) {
          this.recipient = code.data.trim();
          this.scanHint = t("send.address_filled_qr");
          return;
        }
        this.error = t("send.qr_no_address");
        this.scanHint = "";
        return;
      }
      this.applyParsed(parsed);
    } catch (err: unknown) {
      this.scanHint = "";
      this.error = formatInvokeError(err);
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("nh-locale-changed", this.onLocale);
    window.removeEventListener("nighthawk-sync-updated", this.onShellSync);
  }

  private async pollSync() {
    try {
      this.sync = await api.walletLightSync();
    } catch {
      /* send stays disabled until a snapshot arrives */
    }
  }

  private async estimate() {
    this.error = "";
    const validated = validateFeeEstimate({
      sync: this.sync,
      recipient: this.recipient,
      amount: this.amount,
      memo: this.memo,
      tokenId: this.tokenId,
    });
    if (!validated.ok) {
      this.error = sendErrorText(validated.code);
      return;
    }
    try {
      this.fee = await api.estimateFee({
        recipient: validated.recipient,
        amount: validated.amount,
        memo: validated.memo,
        tokenId: validated.tokenId,
      });
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private emitChatReceipt(
    phase: "broadcasted" | "failed",
    address: string,
    txId?: string,
  ) {
    if (!this.chatPayContext) return;
    const receipt: ChatReceipt = {
      id: this.chatPayContext.receiptId,
      phase,
      amount: this.amount.trim() || "0",
      address,
      memo: this.memo.trim() || undefined,
      txId,
    };
    const encoded = encodeReceiptForChat(receipt);
    const detail: ChatReceiptDetail = {
      context: this.chatPayContext,
      receipt,
      encoded,
    };
    window.dispatchEvent(new CustomEvent(CHAT_RECEIPT_EVENT, { detail }));
    this.dispatchEvent(
      new CustomEvent("chat-receipt", {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async send() {
    this.error = "";
    this.result = "";
    let drkAtomic: string;
    try {
      this.tokens = await api.listTokenBalances();
      drkAtomic = await api.walletBalance();
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
      return;
    }

    const validated = validateSendSubmission({
      sync: this.sync,
      recipient: this.recipient,
      amount: this.amount,
      memo: this.memo,
      tokenId: this.tokenId,
      tokens: this.tokens,
      drkBalanceAtomic: drkAtomic,
      estimatedFeeAtomic: this.fee,
    });
    if (!validated.ok) {
      this.error = sendErrorText(validated.code);
      return;
    }

    const dest = validated.recipient;
    if (!confirm(t("send.confirm_prompt", { amount: validated.amount, dest }))) {
      return;
    }
    this.busy = true;
    try {
      const parsed = applyRecipientPaste(this.recipient);
      if (parsed && /^drk:/i.test(this.recipient.trim())) {
        this.applyParsed(parsed);
      }
      this.result = await api.sendDrk({
        recipient: validated.recipient,
        amount: validated.amount,
        memo: validated.memo,
        tokenId: validated.tokenId,
      });
      this.emitChatReceipt("broadcasted", dest, this.result);
      this.chatPayContext = null;
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
      this.emitChatReceipt("failed", dest);
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
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private async removeSelectedContact() {
    if (!this.selectedContactId) return;
    try {
      this.book = await api.addressBookRemove(this.selectedContactId);
      this.selectedContactId = "";
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  render() {
    void this.localeTick;
    return html`
      <label>${t("send.token_label")}</label>
      <select
        .value=${this.tokenId}
        @change=${(e: Event) =>
          (this.tokenId = (e.target as HTMLSelectElement).value)}
      >
        <option value="">${t("token.drk_native")}</option>
        ${this.tokens.map(
          (tok) => html`
            <option value=${tok.tokenId}>
              ${tok.displayLabel || tok.tokenId.slice(0, 12)}…
              (${formatDrkAtomic(parseAtomicDecimal(tok.balanceAtomic) ?? 0n)})
            </option>
          `,
        )}
      </select>
      <label>${t("wallet.amount")}</label>
      <input
        .value=${this.amount}
        placeholder="0.0"
        @input=${(e: Event) =>
          (this.amount = (e.target as HTMLInputElement).value)}
      />
      <label>${t("wallet.address_book")}</label>
      <div class="row tight">
        <select
          .value=${this.selectedContactId}
          @change=${(e: Event) => {
            const id = (e.target as HTMLSelectElement).value;
            this.selectedContactId = id;
            const entry = this.book.find((c) => c.id === id);
            if (entry) this.recipient = entry.address;
          }}
        >
          <option value="">${t("send.select_contact")}</option>
          ${this.book.map(
            (c) => html`<option value=${c.id}>${c.label}</option>`,
          )}
        </select>
        ${this.selectedContactId
          ? html`
              <button
                class="danger compact"
                title=${t("send.remove_contact")}
                @click=${this.removeSelectedContact}
              >
                ${t("common.remove")}
              </button>
            `
          : null}
      </div>
      <label>${t("send.recipient_label")}</label>
      <input
        .value=${this.recipient}
        placeholder=${t("send.recipient_placeholder")}
        @input=${this.onRecipientInput}
        @paste=${this.onRecipientPaste}
      />
      <div class="row tight">
        <input
          placeholder=${t("send.save_label_placeholder")}
          .value=${this.saveLabel}
          @input=${(e: Event) =>
            (this.saveLabel = (e.target as HTMLInputElement).value)}
        />
        <button class="secondary" @click=${this.saveContact}>
          ${t("common.save")}
        </button>
        <button
          class="secondary"
          @click=${() =>
            this.shadowRoot?.querySelector<HTMLInputElement>("#qr-file")?.click()}
        >
          ${t("send.scan_qr_image")}
        </button>
        <input
          id="qr-file"
          type="file"
          accept="image/*"
          @change=${this.onQrFile}
        />
      </div>
      ${this.scanHint ? html`<p class="hint">${this.scanHint}</p>` : null}
      <label>
        ${t("send.memo_label", {
          used: utf8ByteLength(this.memo),
          max: MAX_PAYMENT_MEMO_BYTES,
        })}
      </label>
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
            ${t("send.scheduled_fee", { fee: formatDrkAtomic(this.fee) })}
          </p>`
        : null}
      ${spendReady(this.sync)
        ? null
        : html`<p class="msg">${t("send.scanning_wait")}</p>`}
      <div class="row">
        <button
          class="secondary"
          ?disabled=${this.busy || !spendReady(this.sync)}
          @click=${this.estimate}
        >
          ${t("wallet.estimate_fee")}
        </button>
        <button
          ?disabled=${this.busy || !spendReady(this.sync)}
          @click=${this.send}
        >
          ${this.busy ? t("send.sending") : t("common.send")}
        </button>
      </div>
      ${this.result
        ? html`<p class="msg ok">
            ${t("send.broadcasted", { tx: this.result })}
          </p>`
        : null}
      ${this.error ? html`<p class="msg err">${this.error}</p>` : null}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "send-flow": SendFlow;
  }
}
