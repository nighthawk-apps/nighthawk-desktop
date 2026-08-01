import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import QRCode from "qrcode";
import { api, type TokenBalance, type TxRecord } from "../lib/api";
import type { UnlistenFn } from "@tauri-apps/api/event";

@customElement("wallet-screen")
export class WalletScreen extends LitElement {
  @state() private balance = 0;
  @state() private address = "";
  @state() private sync = "";
  @state() private txs: TxRecord[] = [];
  @state() private tokens: TokenBalance[] = [];
  @state() private txExtra: Record<string, { memo?: string; recipient?: string }> =
    {};
  @state() private qr = "";
  @state() private error = "";
  @state() private reorgMsg = "";
  @state() private reorgHeight: number | null = null;
  private unlistenReorg?: UnlistenFn;

  static styles = css`
    :host {
      display: block;
      padding: 20px;
    }
    .balance {
      font-size: var(--font-size-3xl);
      color: var(--color-text-header);
      font-weight: 700;
    }
    .sub {
      color: var(--color-text-muted);
      font-size: var(--font-size-sm);
      margin-bottom: 16px;
    }
    .card {
      background: var(--color-charcoal-raised);
      border: 1px solid var(--color-steel-border-muted);
      border-radius: var(--border-radius-lg);
      padding: 16px;
      margin-bottom: 16px;
    }
    .addr {
      word-break: break-all;
      font-size: var(--font-size-sm);
      color: var(--color-accent-muted);
    }
    img {
      width: 160px;
      height: 160px;
      margin-top: 12px;
      border-radius: 8px;
      background: white;
      padding: 8px;
    }
    button {
      margin-top: 10px;
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
    .tx {
      padding: 10px 0;
      border-bottom: 1px solid var(--color-steel-border-muted);
      font-size: var(--font-size-sm);
    }
    .err {
      color: var(--color-dangerous);
    }
    .warn {
      color: var(--color-warning);
      font-size: var(--font-size-sm);
      margin-bottom: 12px;
    }
    .token {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      font-size: var(--font-size-sm);
    }
  `;

  async connectedCallback() {
    super.connectedCallback();
    this.unlistenReorg = await api.onReorg((e) => {
      this.reorgMsg = e.summaryMessage;
      this.reorgHeight = e.rewoundTo;
    });
    await this.reload();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unlistenReorg?.();
  }

  private async reload() {
    this.error = "";
    try {
      this.balance = await api.walletBalance();
      this.address = await api.walletAddress();
      const snap = await api.walletLightSync();
      this.sync = `${snap.syncMethod} · ${snap.scannedHeight}/${snap.chainTip} · ${snap.statusMessage}`;
      this.txs = await api.walletListTxs();
      try {
        this.tokens = await api.listTokenBalances();
      } catch {
        this.tokens = [];
      }
      const extras: Record<string, { memo?: string; recipient?: string }> = {};
      for (const t of this.txs.slice(0, 20)) {
        const [memo, recipient] = await Promise.all([
          api.transactionPaymentMemo(t.txHash).catch(() => null),
          api.transactionRecipient(t.txHash).catch(() => null),
        ]);
        if (memo || recipient) {
          extras[t.txHash] = {
            memo: memo ?? undefined,
            recipient: recipient ?? undefined,
          };
        }
      }
      this.txExtra = extras;
      this.qr = await QRCode.toDataURL(this.address, { margin: 1, width: 160 });
      this.dispatchEvent(
        new CustomEvent("sync-update", {
          detail: this.sync,
          bubbles: true,
          composed: true,
        }),
      );
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async refresh() {
    this.error = "";
    try {
      await api.walletRefresh();
      await this.reload();
    } catch (e: any) {
      try {
        await this.reload();
      } catch {
        this.error = String(e);
      }
    }
  }

  private async copy() {
    await navigator.clipboard.writeText(this.address);
  }

  private async recoverReorg() {
    if (this.reorgHeight === null) return;
    this.error = "";
    try {
      const e = await api.handleReorgRecovery(this.reorgHeight);
      this.reorgMsg = e.summaryMessage;
      await this.reload();
    } catch (e: any) {
      this.error = String(e);
    }
  }

  render() {
    const drk = (this.balance / 1e8).toFixed(8);
    return html`
      <div class="balance">${drk} DRK</div>
      <div class="sub">${this.sync || "Syncing…"}</div>
      ${this.reorgMsg
        ? html`<p class="warn">
            Reorg: ${this.reorgMsg}
            ${this.reorgHeight !== null
              ? html`<button @click=${this.recoverReorg}>
                  Recover to h${this.reorgHeight}
                </button>`
              : null}
          </p>`
        : null}
      <div class="card">
        <div class="addr">${this.address}</div>
        ${this.qr ? html`<img src=${this.qr} alt="QR" />` : null}
        <div>
          <button @click=${this.copy}>Copy address</button>
          <button @click=${this.refresh}>Refresh</button>
        </div>
      </div>
      ${this.tokens.length
        ? html`
            <div class="card">
              <h3>Tokens</h3>
              ${this.tokens.map(
                (t) => html`
                  <div class="token">
                    <span>${t.displayLabel || t.tokenId.slice(0, 16)}…</span>
                    <span>${(t.balanceAtomic / 1e8).toFixed(8)}</span>
                  </div>
                `,
              )}
            </div>
          `
        : null}
      <h3>Recent activity</h3>
      ${this.txs.length === 0
        ? html`<p class="sub">No transactions yet</p>`
        : this.txs.map((t) => {
            const x = this.txExtra[t.txHash];
            return html`
              <div class="tx">
                <div>${t.summary || t.txHash.slice(0, 16)}…</div>
                <div class="sub">h${t.height} · ${t.status}</div>
                ${x?.memo
                  ? html`<div class="sub">Memo: ${x.memo}</div>`
                  : null}
                ${x?.recipient
                  ? html`<div class="sub">To: ${x.recipient}</div>`
                  : null}
              </div>
            `;
          })}
      ${this.error ? html`<p class="err">${this.error}</p>` : null}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "wallet-screen": WalletScreen;
  }
}
