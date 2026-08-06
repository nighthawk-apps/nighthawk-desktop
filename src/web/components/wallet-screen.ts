import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import QRCode from "qrcode";
import {
  api,
  type LightSyncState,
  type TokenBalance,
  type TxRecord,
} from "../lib/api";
import type { UnlistenFn } from "@tauri-apps/api/event";

@customElement("wallet-screen")
export class WalletScreen extends LitElement {
  @state() private balance = 0;
  @state() private address = "";
  @state() private sync = "";
  @state() private syncDetail: LightSyncState | null = null;
  @state() private txs: TxRecord[] = [];
  @state() private tokens: TokenBalance[] = [];
  @state() private txExtra: Record<string, { memo?: string; recipient?: string }> =
    {};
  @state() private qr = "";
  @state() private error = "";
  @state() private reorgMsg = "";
  @state() private reorgHeight: number | null = null;
  @state() private refreshing = false;
  private unlistenReorg?: UnlistenFn;
  private pollTimer?: number;

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
      margin-bottom: 8px;
    }
    .sync-card {
      background: var(--color-charcoal-raised);
      border: 1px solid var(--color-steel-border-muted);
      border-radius: var(--border-radius-lg);
      padding: 12px 14px;
      margin-bottom: 16px;
      font-size: var(--font-size-sm);
    }
    .sync-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: baseline;
      margin-bottom: 6px;
    }
    .sync-method {
      font-weight: 700;
      color: var(--color-text-header);
    }
    .sync-method.omr {
      color: #6fbf73;
    }
    .sync-method.trial {
      color: var(--color-warning, #e0a84a);
    }
    .bar {
      height: 6px;
      background: var(--color-elevated);
      border-radius: 999px;
      overflow: hidden;
      margin: 8px 0 4px;
    }
    .bar > span {
      display: block;
      height: 100%;
      background: var(--color-accent);
      border-radius: 999px;
      transition: width 0.3s ease;
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
    button:disabled {
      opacity: 0.6;
      cursor: default;
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
    // Poll light-sync while wallet screen is open (desktop has no bg sync).
    this.pollTimer = window.setInterval(() => this.pollSync(), 4000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unlistenReorg?.();
    if (this.pollTimer) window.clearInterval(this.pollTimer);
  }

  private methodClass(method: string): string {
    const m = method.toLowerCase();
    if (m.includes("unifomr") || m.includes("omr")) return "omr";
    if (m.includes("trial")) return "trial";
    return "";
  }

  private methodLabel(snap: LightSyncState): string {
    const m = snap.syncMethod || snap.syncType || "Unknown";
    if (/unifomr|omr/i.test(m)) return "UnifOMR";
    if (/trial/i.test(m)) return "Trial decrypt";
    return m;
  }

  private progressPct(snap: LightSyncState): number {
    if (!snap.chainTip || snap.chainTip <= 0) return 0;
    return Math.min(100, Math.round((snap.scannedHeight / snap.chainTip) * 100));
  }

  private async pollSync() {
    try {
      const snap = await api.walletLightSync();
      this.applySync(snap);
      // Soft refresh balance occasionally without full tx reload
      this.balance = await api.walletBalance();
    } catch {
      /* ignore transient poll errors */
    }
  }

  private applySync(snap: LightSyncState) {
    this.syncDetail = snap;
    const method = this.methodLabel(snap);
    this.sync = `${method} · ${snap.scannedHeight}/${snap.chainTip} · ${snap.statusMessage}`;
    this.dispatchEvent(
      new CustomEvent("sync-update", {
        detail: this.sync,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async reload() {
    this.error = "";
    try {
      this.balance = await api.walletBalance();
      this.address = await api.walletAddress();
      const snap = await api.walletLightSync();
      this.applySync(snap);
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
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async refresh() {
    this.error = "";
    this.refreshing = true;
    try {
      await api.walletRefresh();
      await this.reload();
    } catch (e: any) {
      try {
        await this.reload();
      } catch {
        this.error = String(e);
      }
    } finally {
      this.refreshing = false;
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
    const snap = this.syncDetail;
    const pct = snap ? this.progressPct(snap) : 0;
    return html`
      <div class="balance">${drk} DRK</div>
      ${snap
        ? html`
            <div class="sync-card">
              <div class="sync-row">
                <span class="sync-method ${this.methodClass(snap.syncMethod)}"
                  >${this.methodLabel(snap)}</span
                >
                <span class="sub" style="margin:0"
                  >${snap.scannedHeight} / ${snap.chainTip} (${pct}%)</span
                >
              </div>
              <div class="bar"><span style="width:${pct}%"></span></div>
              <div class="sub" style="margin:0">
                ${snap.statusMessage || snap.syncTypeMessage || "—"}
                ${snap.omrAvailable ? " · OMR available" : " · OMR unavailable"}
              </div>
              ${snap.fallbackUserMessage
                ? html`<div class="warn" style="margin-top:8px;margin-bottom:0">
                    ${snap.fallbackUserMessage}
                  </div>`
                : null}
            </div>
          `
        : html`<div class="sub">${this.sync || "Syncing…"}</div>`}
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
          <button ?disabled=${this.refreshing} @click=${this.refresh}>
            ${this.refreshing ? "Refreshing…" : "Refresh"}
          </button>
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
