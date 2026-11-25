import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import QRCode from "qrcode";
import {
  api,
  formatInvokeError,
  spendReady,
  type LightSyncState,
  type MintAuthority,
  type TokenBalance,
  type TxRecord,
} from "../lib/api";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { formatDrkAtomic, isValidDrkAmount } from "../lib/amount";
import {
  formatLightSyncBanner,
  formatLightSyncMethod,
  isLightSyncLive,
} from "../lib/sync-label";
import { t } from "../i18n";

@customElement("wallet-screen")
export class WalletScreen extends LitElement {
  @state() private balance = 0;
  @state() private address = "";
  @state() private sync = "";
  @state() private syncDetail: LightSyncState | null = null;
  @state() private txs: TxRecord[] = [];
  @state() private tokens: TokenBalance[] = [];
  @state() private mintAuthorities: MintAuthority[] = [];
  @state() private txExtra: Record<string, { memo?: string; recipient?: string }> =
    {};
  @state() private qr = "";
  @state() private error = "";
  @state() private tokenMessage = "";
  @state() private reorgMsg = "";
  @state() private reorgHeight: number | null = null;
  @state() private refreshing = false;
  @state() private tokenBusy = false;
  @state() private showGenerateToken = false;
  @state() private newTokenAlias = "";
  @state() private mintTargetTokenId = "";
  @state() private mintAmount = "";
  @state() private mintRecipient = "";
  @state() private localeTick = 0;
  private unlistenReorg?: UnlistenFn;
  private onLocale = () => {
    this.localeTick++;
  };
  private onShellSync = (e: Event) => {
    const snap = (e as CustomEvent<LightSyncState>).detail;
    if (!snap) return;
    this.applySync(snap);
    void api
      .walletBalance()
      .then((b) => {
        this.balance = b;
      })
      .catch(() => {
        /* ignore transient balance poll error */
      });
  };

  static styles = css`
    :host {
      display: block;
      padding: 20px;
    }
    .balance {
      font-family: var(--font-family-display);
      font-size: var(--font-size-3xl);
      line-height: 1.25;
      letter-spacing: 0.01em;
      color: var(--color-text-header);
      font-weight: 600;
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
    .actions {
      display: flex;
      gap: 12px;
      margin: 16px 0;
    }
    .actions button.outline {
      flex: 1;
      margin: 0;
      /* Match chat Channels/Direct FilterChip: 8px corners + translucent selected fill */
      background: color-mix(in srgb, var(--color-accent) 38%, transparent);
      color: var(--color-text-header);
      border: 1px solid color-mix(in srgb, var(--color-accent) 55%, transparent);
      border-radius: var(--border-radius-md, 8px);
      padding: 12px 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    .actions button.outline:disabled {
      color: color-mix(in srgb, var(--color-text-header) 40%, transparent);
      border-color: color-mix(in srgb, var(--color-accent) 35%, transparent);
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
      align-items: center;
      gap: 8px;
      padding: 6px 0;
      font-size: var(--font-size-sm);
      flex-wrap: wrap;
    }
    .token-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .token-header h3 {
      margin: 0;
    }
    button.small {
      margin-top: 0;
      padding: 6px 10px;
      font-size: var(--font-size-xs);
    }
    button.secondary {
      background: var(--color-secondary-fill);
      color: var(--color-text-header);
      border: 1px solid var(--color-steel-border);
    }
    button.danger {
      background: var(--color-dangerous-banner-bg);
      color: var(--color-dangerous-banner-fg);
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: var(--font-size-xs);
      border: 1px solid var(--color-steel-border);
      color: var(--color-text-muted);
    }
    .badge.frozen {
      color: var(--color-warning);
      border-color: var(--color-warning);
    }
    .inline-form {
      margin-top: 10px;
      padding: 12px;
      border-radius: var(--border-radius-md);
      background: var(--color-elevated);
      border: 1px solid var(--color-steel-border);
    }
    .inline-form label {
      display: block;
      margin-top: 8px;
      font-size: var(--font-size-xs);
      color: var(--color-text-muted);
    }
    .inline-form input {
      width: 100%;
      box-sizing: border-box;
      margin-top: 4px;
      padding: 8px 10px;
      border-radius: var(--border-radius-md);
      border: 1px solid var(--color-steel-border);
      background: var(--color-charcoal-deep);
      color: var(--color-text-header);
      font-family: inherit;
    }
    .ok {
      color: var(--color-accent-muted);
      font-size: var(--font-size-sm);
      word-break: break-all;
    }
  `;

  async connectedCallback() {
    super.connectedCallback();
    window.addEventListener("nh-locale-changed", this.onLocale);
    this.unlistenReorg = await api.onReorg((e) => {
      this.reorgMsg = e.summaryMessage;
      this.reorgHeight = e.rewoundTo;
    });
    await this.reload();
    window.addEventListener("nighthawk-sync-updated", this.onShellSync);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unlistenReorg?.();
    window.removeEventListener("nh-locale-changed", this.onLocale);
    window.removeEventListener("nighthawk-sync-updated", this.onShellSync);
  }

  /** The method sticks from the last good cycle; only a live session is green. */
  private lwdLive(snap: LightSyncState): boolean {
    return isLightSyncLive(snap);
  }

  private methodClass(snap: LightSyncState): string {
    if (!this.lwdLive(snap)) return "trial";
    const m = snap.syncMethod.toLowerCase();
    if (m.includes("unifomr") || m.includes("omr")) return "omr";
    if (m.includes("trial")) return "trial";
    return "";
  }

  private methodLabel(snap: LightSyncState): string {
    return formatLightSyncMethod(snap);
  }

  private progressPct(snap: LightSyncState): number {
    if (!snap.chainTip || snap.chainTip <= 0) return 0;
    return Math.min(100, Math.round((snap.scannedHeight / snap.chainTip) * 100));
  }

  private applySync(snap: LightSyncState) {
    this.syncDetail = snap;
    this.sync = formatLightSyncBanner(snap);
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
      try {
        this.mintAuthorities = await api.listMintAuthorities();
      } catch {
        this.mintAuthorities = [];
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
      this.error = formatInvokeError(e);
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
        this.error = formatInvokeError(e);
      }
    } finally {
      this.refreshing = false;
    }
  }

  private async copy() {
    await navigator.clipboard.writeText(this.address);
  }

  private openTransfer(tab: "request" | "receive" | "send") {
    this.dispatchEvent(
      new CustomEvent("open-transfer", {
        detail: tab,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async recoverReorg() {
    if (this.reorgHeight === null) return;
    this.error = "";
    try {
      const e = await api.handleReorgRecovery(this.reorgHeight);
      this.reorgMsg = e.summaryMessage;
      await this.reload();
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private async generateToken() {
    this.error = "";
    this.tokenMessage = "";
    this.tokenBusy = true;
    try {
      const id = await api.tokenGenerate(this.newTokenAlias.trim() || undefined);
      this.tokenMessage = t("wallet.token_generated", { id });
      this.newTokenAlias = "";
      this.showGenerateToken = false;
      this.mintAuthorities = await api.listMintAuthorities().catch(() => []);
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    } finally {
      this.tokenBusy = false;
    }
  }

  private async mintToken() {
    if (!this.mintTargetTokenId) return;
    if (!isValidDrkAmount(this.mintAmount)) {
      this.error = t("wallet.invalid_mint_amount");
      return;
    }
    const recipient = (this.mintRecipient || this.address).trim();
    if (!recipient) {
      this.error = t("wallet.recipient_required");
      return;
    }
    this.error = "";
    this.tokenMessage = "";
    this.tokenBusy = true;
    try {
      const tx = await api.tokenMint({
        tokenId: this.mintTargetTokenId,
        amount: this.mintAmount.trim(),
        recipientAddress: recipient,
      });
      this.tokenMessage = t("wallet.token_minted", { tx });
      this.mintTargetTokenId = "";
      this.mintAmount = "";
      await this.reload();
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    } finally {
      this.tokenBusy = false;
    }
  }

  private async freezeToken(tokenId: string, label: string) {
    if (!confirm(t("wallet.confirm_freeze", { label }))) {
      return;
    }
    this.error = "";
    this.tokenMessage = "";
    this.tokenBusy = true;
    try {
      const tx = await api.tokenFreeze(tokenId);
      this.tokenMessage = t("wallet.token_frozen", { tx });
      await this.reload();
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    } finally {
      this.tokenBusy = false;
    }
  }

  render() {
    void this.localeTick;
    const drk = formatDrkAtomic(this.balance);
    const snap = this.syncDetail;
    const pct = snap ? this.progressPct(snap) : 0;
    return html`
      <div class="balance">${drk} DRK</div>
      ${snap
        ? html`
            <div class="sync-card">
              <div class="sync-row">
                <span class="sync-method ${this.methodClass(snap)}"
                  >${this.methodLabel(snap)}</span
                >
                <span class="sub" style="margin:0"
                  >${snap.scannedHeight} / ${snap.chainTip} (${pct}%)</span
                >
              </div>
              <div class="bar"><span style="width:${pct}%"></span></div>
              <div class="sub" style="margin:0">
                ${snap.statusMessage || snap.syncTypeMessage || "—"}
                · ${snap.omrAvailable ? t("wallet.omr_available") : t("wallet.omr_unavailable")}
                ${spendReady(snap) ? "" : ` · ${t("wallet.send_wait_short")}`}
              </div>
              ${snap.fallbackUserMessage
                ? html`<div class="warn" style="margin-top:8px;margin-bottom:0">
                    ${snap.fallbackUserMessage}
                  </div>`
                : null}
              ${snap.protoVersionMismatch
                ? html`<div class="warn" style="margin-top:8px;margin-bottom:0;color:#f39c12">
                    ⚠️ ${t("wallet.proto_mismatch")}
                  </div>`
                : null}
            </div>
          `
        : html`<div class="sub">${this.sync || t("wallet.syncing")}</div>`}
      ${this.reorgMsg
        ? html`<p class="warn">
            ${t("wallet.reorg_prefix")} ${this.reorgMsg}
            ${this.reorgHeight !== null
              ? html`<button @click=${this.recoverReorg}>
                  ${t("wallet.recover_to_height", { height: this.reorgHeight })}
                </button>`
              : null}
          </p>`
        : null}
      <div class="actions">
        <button class="outline" @click=${() => this.openTransfer("request")}>
          ${t("nav.request")}
        </button>
        <button class="outline" @click=${() => this.openTransfer("receive")}>
          ${t("nav.receive")}
        </button>
        <button
          class="outline"
          ?disabled=${!(snap ? spendReady(snap) : false)}
          @click=${() => this.openTransfer("send")}
        >
          ${t("nav.send")}
        </button>
      </div>
      <div class="card">
        <div class="addr">${this.address}</div>
        ${this.qr ? html`<img src=${this.qr} alt="QR" />` : null}
        <div>
          <button @click=${this.copy}>${t("wallet.copy_address")}</button>
          <button ?disabled=${this.refreshing} @click=${this.refresh}>
            ${this.refreshing ? t("common.refreshing") : t("common.refresh")}
          </button>
        </div>
      </div>
      <div class="card">
        <div class="token-header">
          <h3>${t("wallet.tokens_and_minting")}</h3>
          <button
            class="secondary small"
            ?disabled=${this.tokenBusy}
            @click=${() => {
              this.showGenerateToken = !this.showGenerateToken;
              this.error = "";
            }}
          >
            ${this.showGenerateToken ? t("common.close") : t("wallet.generate_token")}
          </button>
        </div>
        ${this.showGenerateToken
          ? html`
              <div class="inline-form">
                <label>${t("wallet.alias_optional")}</label>
                <input
                  placeholder=${t("wallet.alias_placeholder")}
                  .value=${this.newTokenAlias}
                  @input=${(e: Event) =>
                    (this.newTokenAlias = (e.target as HTMLInputElement).value)}
                />
                <div style="margin-top: 10px">
                  <button
                    class="small"
                    ?disabled=${this.tokenBusy}
                    @click=${this.generateToken}
                  >
                    ${this.tokenBusy
                      ? t("wallet.generating")
                      : t("wallet.create_mint_authority")}
                  </button>
                </div>
              </div>
            `
          : null}
        ${this.tokens.length
          ? html`
              ${this.tokens.map(
                (tok) => html`
                  <div class="token">
                    <span>${tok.displayLabel || `${tok.tokenId.slice(0, 16)}…`}</span>
                    <span>${formatDrkAtomic(tok.balanceAtomic)}</span>
                  </div>
                `,
              )}
            `
          : html`<div class="sub">${t("wallet.no_custom_tokens")}</div>`}
        ${this.mintAuthorities.length
          ? html`
              <div style="margin-top: 12px">
                <div class="sub" style="margin-bottom: 6px">
                  ${t("wallet.mint_authorities")}
                </div>
                ${this.mintAuthorities.map((a) => {
                  const display = a.alias || `${a.tokenId.slice(0, 14)}…`;
                  const isMinting = this.mintTargetTokenId === a.tokenId;
                  return html`
                    <div class="token">
                      <span>
                        <strong>${display}</strong>
                        <span class="badge ${a.frozen ? "frozen" : ""}"
                          >${a.frozen ? t("wallet.frozen") : t("wallet.mintable")}</span
                        >
                      </span>
                      <span>
                        <button
                          class="small"
                          ?disabled=${a.frozen || this.tokenBusy || !(snap ? spendReady(snap) : false)}
                          @click=${() => {
                            this.mintTargetTokenId = isMinting ? "" : a.tokenId;
                            this.mintRecipient = this.address;
                            this.mintAmount = "";
                          }}
                        >
                          ${isMinting ? t("common.cancel") : t("wallet.mint")}
                        </button>
                        <button
                          class="danger small"
                          ?disabled=${a.frozen || this.tokenBusy || !(snap ? spendReady(snap) : false)}
                          @click=${() => this.freezeToken(a.tokenId, display)}
                        >
                          ${t("wallet.freeze")}
                        </button>
                      </span>
                    </div>
                    ${isMinting
                      ? html`
                          <div class="inline-form">
                            <label>${t("wallet.amount_to_mint")}</label>
                            <input
                              placeholder="e.g. 100"
                              .value=${this.mintAmount}
                              @input=${(e: Event) =>
                                (this.mintAmount = (e.target as HTMLInputElement).value)}
                            />
                            <label>${t("wallet.recipient_address")}</label>
                            <input
                              .value=${this.mintRecipient}
                              @input=${(e: Event) =>
                                (this.mintRecipient = (e.target as HTMLInputElement).value)}
                            />
                            <div style="margin-top: 10px">
                              <button
                                class="small"
                                ?disabled=${this.tokenBusy}
                                @click=${this.mintToken}
                              >
                                ${this.tokenBusy
                                  ? t("wallet.minting")
                                  : t("wallet.confirm_mint")}
                              </button>
                            </div>
                          </div>
                        `
                      : null}
                  `;
                })}
              </div>
            `
          : null}
        ${this.tokenMessage ? html`<p class="ok">${this.tokenMessage}</p>` : null}
      </div>
      <h3>${t("wallet.recent_activity")}</h3>
      ${this.txs.length === 0
        ? html`<p class="sub">${t("wallet.no_transactions")}</p>`
        : this.txs.map((tx) => {
            const x = this.txExtra[tx.txHash];
            return html`
              <div class="tx">
                <div>${tx.summary || tx.txHash.slice(0, 16)}…</div>
                <div class="sub">h${tx.height} · ${tx.status}</div>
                ${x?.memo
                  ? html`<div class="sub">${t("wallet.memo_prefix")} ${x.memo}</div>`
                  : null}
                ${x?.recipient
                  ? html`<div class="sub">${t("wallet.to_prefix")} ${x.recipient}</div>`
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
