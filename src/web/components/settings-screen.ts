import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { getVersion } from "@tauri-apps/api/app";
import {
  api,
  formatInvokeError,
  type Network,
  type Prefs,
  type WalletProfiles,
} from "../lib/api";
import { applyTheme, currentTheme, type NighthawkTheme } from "../lib/theme";
import { fudOffersEnabled, setFudOffersEnabled } from "../lib/chat-chrome";
import {
  getLocale,
  setLocale,
  supportedLocales,
  t,
  type LocaleCode,
} from "../i18n";

/** Module-level timer so seed clipboard auto-clear fires even if the user navigates away. */
let seedClipboardClearTimer: number | undefined;
const SEED_CLIPBOARD_CLEAR_MS = 60_000;
const SEED_DISPLAY_TIMEOUT_MS = 60_000;

@customElement("settings-screen")
export class SettingsScreen extends LitElement {
  /** When opened from chat chrome, show "Chat Settings" as the screen title. */
  @property({ type: String }) screenTitle = "Settings";
  @state() private prefs: Prefs | null = null;
  @state() private backup: string[] = [];
  @state() private backupCopied = false;
  @state() private message = "";
  @state() private error = "";
  @state() private artiRunning = false;
  @state() private wallets: WalletProfiles | null = null;
  @state() private theme: NighthawkTheme = currentTheme();
  @state() private newWalletLabel = "";
  @state() private renameLabel = "";
  @state() private appVersion = "";
  @state() private locale: LocaleCode = getLocale();
  private backupHideTimer?: number;
  private backupCopiedTimer?: number;

  static styles = css`
    :host {
      display: block;
      padding: 20px;
    }
    .card {
      background: var(--color-charcoal-raised);
      border: 1px solid var(--color-steel-border-muted);
      border-radius: var(--border-radius-lg);
      padding: 16px;
      margin-bottom: 12px;
    }
    h2.screen-title {
      margin: 0 0 16px;
      font-family: var(--font-family-display);
      font-size: var(--font-size-xl);
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--color-text-header);
    }
    h3 {
      margin: 0 0 12px;
      font-size: var(--font-size-lg);
    }
    label {
      display: block;
      margin-top: 10px;
      font-size: var(--font-size-sm);
      color: var(--color-text-muted);
    }
    input,
    select {
      width: 100%;
      box-sizing: border-box;
      margin-top: 6px;
      padding: 10px;
      border-radius: var(--border-radius-md);
      border: 1px solid var(--color-steel-border);
      background: var(--color-elevated);
      color: var(--color-text-header);
      font-family: inherit;
    }
    button {
      margin-top: 12px;
      margin-right: 8px;
      padding: 10px 14px;
      border: none;
      border-radius: var(--border-radius-md);
      background: var(--color-accent);
      color: var(--color-on-accent);
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    button.danger {
      background: var(--color-dangerous-banner-bg);
      color: var(--color-dangerous-banner-fg);
    }
    button.secondary {
      background: var(--color-secondary-fill);
      color: var(--color-text-header);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .words {
      font-size: var(--font-size-sm);
      word-break: break-word;
      color: var(--color-accent-muted);
    }
    .msg {
      color: var(--color-accent-muted);
    }
    .err {
      color: var(--color-dangerous);
    }
    .hint {
      font-size: var(--font-size-xs);
      color: var(--color-text-muted);
    }
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .wallet-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 12px;
    }
    .wallet-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
      padding: 10px 12px;
      border-radius: var(--border-radius-md);
      background: var(--color-elevated);
      border: 1px solid var(--color-steel-border);
    }
    .wallet-item.active {
      border-color: var(--color-accent);
    }
    .wallet-item-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .wallet-item-actions button {
      margin: 0;
      padding: 6px 10px;
      font-size: var(--font-size-xs);
    }
  `;

  async connectedCallback() {
    super.connectedCallback();
    this.prefs = await api.getPrefs();
    if (this.prefs && this.prefs.strictOmrOnly === undefined) {
      this.prefs.strictOmrOnly = false;
    }
    this.artiRunning = await api.artiStatus();
    this.wallets = await api.walletsList();
    try {
      this.appVersion = await getVersion();
    } catch {
      this.appVersion = "";
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.clearBackupDisplay();
  }

  private clearBackupDisplay() {
    this.backup = [];
    this.backupCopied = false;
    if (this.backupHideTimer) {
      window.clearTimeout(this.backupHideTimer);
      this.backupHideTimer = undefined;
    }
    if (this.backupCopiedTimer) {
      window.clearTimeout(this.backupCopiedTimer);
      this.backupCopiedTimer = undefined;
    }
  }

  private async copyBackupSeed() {
    if (!this.backup.length) return;
    const phrase = this.backup.join(" ");
    try {
      await navigator.clipboard.writeText(phrase);
      this.backupCopied = true;
      this.message = t("settings.seed_copied_msg");
      if (this.backupCopiedTimer) window.clearTimeout(this.backupCopiedTimer);
      this.backupCopiedTimer = window.setTimeout(() => {
        this.backupCopied = false;
      }, 3000);
      if (seedClipboardClearTimer) window.clearTimeout(seedClipboardClearTimer);
      seedClipboardClearTimer = window.setTimeout(() => {
        seedClipboardClearTimer = undefined;
        void navigator.clipboard.writeText("").catch(() => undefined);
      }, SEED_CLIPBOARD_CLEAR_MS);
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private async save() {
    if (!this.prefs) return;
    this.error = "";
    this.message = "";
    try {
      await api.setPrefs(this.prefs);
      this.prefs = await api.getPrefs();
      this.artiRunning = await api.artiStatus();
      this.message = t("settings.prefs_saved");
      this.dispatchEvent(
        new CustomEvent("prefs-changed", { bubbles: true, composed: true }),
      );
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
      this.prefs = await api.getPrefs().catch(() => this.prefs);
    }
  }

  private async switchNetwork(n: Network) {
    this.error = "";
    this.message = "";
    try {
      await api.setNetwork(n);
      this.prefs = await api.getPrefs();
      this.message = t("settings.network_set", {
        network: n === "mainnet" ? t("network.mainnet") : t("network.testnet"),
      });
      this.dispatchEvent(
        new CustomEvent("prefs-changed", { bubbles: true, composed: true }),
      );
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
      this.prefs = await api.getPrefs().catch(() => this.prefs);
    }
  }

  private async doBackup() {
    if (!confirm(t("settings.confirm_show_seed"))) {
      return;
    }
    this.error = "";
    try {
      this.backup = await api.backupMnemonic();
      this.message = t("settings.seed_shown_msg");
      if (this.backupHideTimer) window.clearTimeout(this.backupHideTimer);
      this.backupHideTimer = window.setTimeout(() => {
        this.clearBackupDisplay();
      }, SEED_DISPLAY_TIMEOUT_MS);
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private async wipe() {
    if (!confirm(t("settings.confirm_wipe"))) return;
    this.error = "";
    try {
      this.clearBackupDisplay();
      await api.wipeWallet();
      location.reload();
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private async toggleArti() {
    this.error = "";
    try {
      if (this.artiRunning) {
        await api.artiStop();
      } else {
        await api.artiStart();
      }
      this.artiRunning = await api.artiStatus();
      this.message = this.artiRunning
        ? t("settings.arti_started_msg")
        : t("settings.arti_stopped_msg");
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private async createWalletProfile() {
    this.error = "";
    try {
      await api.walletsCreate(
        this.newWalletLabel || t("settings.wallet_default_new_name"),
      );
      this.wallets = await api.walletsList();
      this.message = t("settings.wallet_created_msg");
      location.reload();
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private async switchWallet(id: string) {
    this.error = "";
    try {
      await api.walletsSwitch(id);
      this.message = t("settings.wallet_switched_msg");
      location.reload();
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private async renameWallet() {
    if (!this.wallets) return;
    this.error = "";
    const id = this.wallets.activeId;
    const label = this.renameLabel.trim();
    if (!label) {
      this.error = t("settings.wallet_enter_label");
      return;
    }
    try {
      await api.walletsRename(id, label);
      this.wallets = await api.walletsList();
      this.renameLabel = "";
      this.message = t("settings.wallet_renamed_msg");
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private async removeWallet(id: string, label: string) {
    if (!this.wallets) return;
    this.error = "";
    if (id === "default") {
      this.error = t("settings.wallet_cannot_remove_primary");
      return;
    }
    if (id === this.wallets.activeId) {
      this.error = t("settings.wallet_switch_to_remove");
      return;
    }
    if (!confirm(t("settings.wallet_confirm_remove", { label }))) {
      return;
    }
    try {
      await api.walletsRemove(id);
      this.wallets = await api.walletsList();
      this.message = t("settings.wallet_removed_msg", { label });
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  render() {
    const p = this.prefs;
    if (!p) return html`<p>${t("common.loading")}</p>`;
    return html`
      <h2 class="screen-title">${this.screenTitle === "Settings" ? t("nav.settings") : this.screenTitle}</h2>
      <div class="card">
        <h3>${t("settings.appearance")}</h3>
        <label>${t("settings.language")}</label>
        <select
          .value=${this.locale}
          @change=${(e: Event) => {
            const next = (e.target as HTMLSelectElement).value as LocaleCode;
            this.locale = next;
            setLocale(next);
            this.requestUpdate();
          }}
        >
          ${supportedLocales.map(
            (loc) => html`<option value=${loc.code}>${loc.label}</option>`,
          )}
        </select>
        <label>${t("settings.theme")}</label>
        <select
          .value=${this.theme}
          @change=${(e: Event) => {
            const next = (e.target as HTMLSelectElement).value as NighthawkTheme;
            this.theme = next;
            applyTheme(next);
          }}
        >
          <option value="cyberpunk">${t("settings.theme_cyberpunk")}</option>
          <option value="stealth">${t("settings.theme_stealth")}</option>
          <option value="midnight">${t("settings.theme_midnight")}</option>
          <option value="light">${t("settings.theme_light")}</option>
          <option value="paper">${t("settings.theme_paper")}</option>
        </select>
        <label class="row">
          <input
            type="checkbox"
            .checked=${fudOffersEnabled()}
            @change=${(e: Event) =>
              setFudOffersEnabled((e.target as HTMLInputElement).checked)}
          />
          ${t("settings.fud_offers")}
        </label>
      </div>
      <div class="card">
        <h3>${t("network.label")}</h3>
        <select
          .value=${p.network}
          @change=${(e: Event) =>
            this.switchNetwork((e.target as HTMLSelectElement).value as Network)}
        >
          <option value="testnet">${t("network.testnet")}</option>
          <option value="mainnet">${t("network.mainnet")}</option>
        </select>
        <label>${t("settings.lwd_url")}</label>
        <input
          .value=${p.lightwalletUrl}
          @input=${(e: Event) => {
            p.lightwalletUrl = (e.target as HTMLInputElement).value;
            this.requestUpdate();
          }}
        />
        <label>${t("settings.lwd_tls_pin")}</label>
        <input
          placeholder=${t("settings.tls_pin_placeholder")}
          .value=${p.lightwalletTlsPinSha256 ?? ""}
          @input=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value.trim();
            p.lightwalletTlsPinSha256 = v || null;
            this.requestUpdate();
          }}
        />
        <label>${t("settings.stratum_url")}</label>
        <input
          .value=${p.stratumUrl}
          @input=${(e: Event) => {
            p.stratumUrl = (e.target as HTMLInputElement).value;
            this.requestUpdate();
          }}
        />
        <label>${t("chat.nick")}</label>
        <input
          .value=${p.chatNick}
          @input=${(e: Event) => {
            p.chatNick = (e.target as HTMLInputElement).value;
            this.requestUpdate();
          }}
        />
        <label>${t("settings.privacy_transport")}</label>
        <select
          .value=${p.useNym ? "nym" : p.useTor ? "tor" : "direct"}
          @change=${(e: Event) => {
            const mode = (e.target as HTMLSelectElement).value;
            p.useNym = mode === "nym";
            p.useTor = mode === "tor";
            this.requestUpdate();
          }}
        >
          <option value="tor">${t("settings.transport_tor")}</option>
          <option value="nym">${t("settings.transport_nym")}</option>
          <option value="direct">${t("settings.transport_direct")}</option>
        </select>
        <label>${t("settings.tor_socks_port")}</label>
        <input
          type="number"
          .value=${String(p.torSocksPort)}
          @input=${(e: Event) => {
            p.torSocksPort = Number((e.target as HTMLInputElement).value) || 9150;
            this.requestUpdate();
          }}
        />
        <label>${t("settings.nym_socks_port")}</label>
        <input
          type="number"
          .value=${String(p.nymSocksPort ?? 1080)}
          @input=${(e: Event) => {
            p.nymSocksPort = Number((e.target as HTMLInputElement).value) || 1080;
            this.requestUpdate();
          }}
        />
        <label>
          <input
            type="checkbox"
            .checked=${p.strictOmrOnly}
            @change=${(e: Event) => {
              p.strictOmrOnly = (e.target as HTMLInputElement).checked;
              this.requestUpdate();
            }}
          />
          ${t("settings.experimental_omr")}
        </label>
        <p class="msg">${t("settings.experimental_omr_hint")}</p>
        <div class="row">
          <button @click=${this.save}>${t("common.save")}</button>
          <button class="secondary" @click=${this.toggleArti}>
            ${this.artiRunning ? t("settings.stop_arti") : t("settings.start_arti")}
          </button>
          <span class="msg">
            ${t("settings.arti_status", {
              state: this.artiRunning
                ? t("settings.arti_running")
                : t("settings.arti_stopped"),
            })}
          </span>
        </div>
      </div>

      <div class="card">
        <h3>${t("settings.wallets_heading")}</h3>
        ${this.wallets
          ? html`
              <div class="wallet-list">
                ${this.wallets.wallets.map((w) => {
                  const isActive = w.id === this.wallets!.activeId;
                  const isDefault = w.id === "default";
                  return html`
                    <div class="wallet-item ${isActive ? "active" : ""}">
                      <div>
                        <strong>${w.label}</strong>
                        ${isActive
                          ? html` <span class="msg">${t("settings.wallet_active_tag")}</span>`
                          : null}
                        ${isDefault
                          ? html`<div class="hint">
                              ${t("settings.wallet_primary_hint")}
                            </div>`
                          : isActive
                            ? html`<div class="hint">
                                ${t("settings.wallet_switch_to_remove")}
                              </div>`
                            : null}
                      </div>
                      <div class="wallet-item-actions">
                        ${!isActive
                          ? html`
                              <button
                                class="secondary"
                                @click=${() => this.switchWallet(w.id)}
                              >
                                ${t("common.switch")}
                              </button>
                            `
                          : null}
                        ${!isDefault
                          ? html`
                              <button
                                class="danger"
                                ?disabled=${isActive}
                                title=${isActive
                                  ? t("settings.wallet_switch_to_remove")
                                  : `${t("wallet.remove")}: ${w.label}`}
                                @click=${() => this.removeWallet(w.id, w.label)}
                              >
                                ${t("common.remove")}
                              </button>
                            `
                          : null}
                      </div>
                    </div>
                  `;
                })}
              </div>
            `
          : null}
        <div class="row">
          <input
            placeholder=${t("settings.wallet_new_label")}
            .value=${this.newWalletLabel}
            @input=${(e: Event) =>
              (this.newWalletLabel = (e.target as HTMLInputElement).value)}
          />
          <button class="secondary" @click=${this.createWalletProfile}>
            ${t("wallet.add")}
          </button>
        </div>
        <div class="row">
          <input
            placeholder=${t("settings.wallet_rename_placeholder")}
            .value=${this.renameLabel}
            @input=${(e: Event) =>
              (this.renameLabel = (e.target as HTMLInputElement).value)}
          />
          <button class="secondary" @click=${this.renameWallet}>
            ${t("common.rename")}
          </button>
        </div>
      </div>

      <div class="card">
        <h3>${t("settings.security_heading")}</h3>
        <p>${t("settings.security_notice")}</p>
        <div class="row">
          <button @click=${this.doBackup}>${t("settings.show_seed_backup")}</button>
          <button class="danger" @click=${this.wipe}>
            ${t("settings.wipe_wallet")}
          </button>
        </div>
        ${this.backup.length
          ? html`
              <div style="margin-top: 12px">
                <p class="words">${this.backup.join(" ")}</p>
                <div class="row">
                  <button class="secondary" @click=${this.copyBackupSeed}>
                    ${this.backupCopied
                      ? t("settings.seed_copied_btn")
                      : t("settings.copy_seed_phrase")}
                  </button>
                  <button class="secondary" @click=${this.clearBackupDisplay}>
                    ${t("settings.hide_seed")}
                  </button>
                </div>
              </div>
            `
          : null}
      </div>
      <div class="card">
        <h3>${t("nav.about")}</h3>
        <p>${t("settings.about_line", { version: this.appVersion || "3.1.21" })}</p>
      </div>
      ${this.message ? html`<p class="msg">${this.message}</p>` : null}
      ${this.error ? html`<p class="err">${this.error}</p>` : null}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-screen": SettingsScreen;
  }
}
