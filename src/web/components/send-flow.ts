import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  api,
  prefsFeeTier,
  type AddressBookEntry,
  type FeeTier,
  type Prefs,
  type TokenBalance,
} from "../lib/api";

@customElement("send-flow")
export class SendFlow extends LitElement {
  @state() private recipient = "";
  @state() private amount = "";
  @state() private memo = "";
  @state() private tokenId = "";
  @state() private tokens: TokenBalance[] = [];
  @state() private book: AddressBookEntry[] = [];
  @state() private feeTier: FeeTier = "normal";
  @state() private fee: number | null = null;
  @state() private result = "";
  @state() private error = "";
  @state() private busy = false;
  @state() private saveLabel = "";

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
  `;

  async connectedCallback() {
    super.connectedCallback();
    try {
      const prefs = await api.getPrefs();
      this.feeTier = prefsFeeTier(prefs);
      this.tokens = await api.listTokenBalances();
      this.book = await api.addressBookList();
    } catch {
      /* wallet may still be settling */
    }
  }

  private async setTier(tier: FeeTier) {
    this.feeTier = tier;
    try {
      const prefs = await api.getPrefs();
      (prefs as Prefs).feeTier = tier;
      await api.setPrefs(prefs);
      if (this.fee !== null) await this.estimate();
    } catch (e: any) {
      this.error = String(e);
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
    this.busy = true;
    try {
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
      <label>Recipient address</label>
      <input
        .value=${this.recipient}
        @input=${(e: Event) =>
          (this.recipient = (e.target as HTMLInputElement).value)}
      />
      <div class="row">
        <input
          placeholder="Save as label"
          .value=${this.saveLabel}
          @input=${(e: Event) =>
            (this.saveLabel = (e.target as HTMLInputElement).value)}
        />
        <button class="secondary" @click=${this.saveContact}>Save</button>
      </div>
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
      <label>Fee preference</label>
      <div class="tiers">
        ${(["economy", "normal", "priority"] as FeeTier[]).map(
          (t) => html`
            <button
              class=${this.feeTier === t ? "active" : ""}
              @click=${() => this.setTier(t)}
            >
              ${t}
            </button>
          `,
        )}
      </div>
      <label>Memo (optional)</label>
      <textarea
        rows="2"
        .value=${this.memo}
        @input=${(e: Event) =>
          (this.memo = (e.target as HTMLTextAreaElement).value)}
      ></textarea>
      ${this.fee !== null
        ? html`<p class="msg">
            Estimated fee (${this.feeTier}): ${(this.fee / 1e8).toFixed(8)} DRK
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
