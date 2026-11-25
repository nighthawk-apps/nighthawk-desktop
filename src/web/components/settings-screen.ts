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
      this.message = "Seed phrase copied — clipboard will auto-clear in 60s";
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
      this.message = "Preferences saved";
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
      this.message = `Network set to ${n}.`;
      this.dispatchEvent(
        new CustomEvent("prefs-changed", { bubbles: true, composed: true }),
      );
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
      this.prefs = await api.getPrefs().catch(() => this.prefs);
    }
  }

  private async doBackup() {
    if (
      !confirm(
        "Show your seed phrase? Anyone who sees it can spend your funds.",
      )
    ) {
      return;
    }
    this.error = "";
    try {
      this.backup = await api.backupMnemonic();
      this.message = "Seed shown — auto-hides in 60s. Store safely.";
      if (this.backupHideTimer) window.clearTimeout(this.backupHideTimer);
      this.backupHideTimer = window.setTimeout(() => {
        this.clearBackupDisplay();
      }, SEED_DISPLAY_TIMEOUT_MS);
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private async wipe() {
    if (!confirm("Wipe all wallet data on this device?")) return;
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
      this.message = this.artiRunning ? "Arti Tor proxy started" : "Arti stopped";
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private async createWalletProfile() {
    this.error = "";
    try {
      await api.walletsCreate(this.newWalletLabel || "New wallet");
      this.wallets = await api.walletsList();
      this.message =
        "New wallet profile created — complete onboarding / restore.";
      location.reload();
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private async switchWallet(id: string) {
    this.error = "";
    try {
      await api.walletsSwitch(id);
      this.message = "Switched wallet — reloading…";
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
      this.error = "Enter a new label";
      return;
    }
    try {
      await api.walletsRename(id, label);
      this.wallets = await api.walletsList();
      this.renameLabel = "";
      this.message = "Wallet renamed";
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private async removeWallet(id: string, label: string) {
    if (!this.wallets) return;
    this.error = "";
    if (id === "default") {
      this.error = "Cannot remove the primary wallet profile — use Wipe wallet instead";
      return;
    }
    if (id === this.wallets.activeId) {
      this.error = "Switch to another wallet first to remove this one";
      return;
    }
    if (
      !confirm(
        `Remove wallet profile "${label}"? This permanently deletes that profile’s vault data.`,
      )
    ) {
      return;
    }
    try {
      await api.walletsRemove(id);
      this.wallets = await api.walletsList();
      this.message = `Removed wallet profile "${label}"`;
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
          placeholder="Optional for localhost; required for remote HTTPS"
          .value=${p.lightwalletTlsPinSha256 ?? ""}
          @input=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value.trim();
            p.lightwalletTlsPinSha256 = v || null;
            this.requestUpdate();
          }}
        />
        <label>Stratum URL (mining)</label>
        <input
          .value=${p.stratumUrl}
          @input=${(e: Event) => {
            p.stratumUrl = (e.target as HTMLInputElement).value;
            this.requestUpdate();
          }}
        />
        <label>Chat nick</label>
        <input
          .value=${p.chatNick}
          @input=${(e: Event) => {
            p.chatNick = (e.target as HTMLInputElement).value;
            this.requestUpdate();
          }}
        />
        <label>Privacy transport</label>
        <select
          .value=${p.useNym ? "nym" : p.useTor ? "tor" : "direct"}
          @change=${(e: Event) => {
            const mode = (e.target as HTMLSelectElement).value;
            p.useNym = mode === "nym";
            p.useTor = mode === "tor";
            this.requestUpdate();
          }}
        >
          <option value="tor">Tor (embedded Arti)</option>
          <option value="nym">Nym mixnet</option>
          <option value="direct">Direct (clearnet)</option>
        </select>
        <label>Tor SOCKS port</label>
        <input
          type="number"
          .value=${String(p.torSocksPort)}
          @input=${(e: Event) => {
            p.torSocksPort = Number((e.target as HTMLInputElement).value) || 9150;
            this.requestUpdate();
          }}
        />
        <label>Nym SOCKS port</label>
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
          Experimental UnifOMR (off by default; both wallets must register on this server)
        </label>
        <p class="msg">
          Off by default: when enabled, only payments with UnifOMR clues are
          discovered — faster and more private, but <code>drk</code> sends may
          not appear. Leave off to receive from all wallets via trial decryption.
        </p>
        <div class="row">
          <button @click=${this.save}>Save</button>
          <button class="secondary" @click=${this.toggleArti}>
            ${this.artiRunning ? "Stop Arti" : "Start Arti"}
          </button>
          <span class="msg"
            >Arti: ${this.artiRunning ? "running" : "stopped"}</span
          >
        </div>
      </div>

      <div class="card">
        <h3>Wallets</h3>
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
                        ${isActive ? html` <span class="msg">(active)</span>` : null}
                        ${isDefault
                          ? html`<div class="hint">Primary profile (use Wipe wallet below to reset)</div>`
                          : isActive
                            ? html`<div class="hint">Switch to another wallet first to remove this one</div>`
                            : null}
                      </div>
                      <div class="wallet-item-actions">
                        ${!isActive
                          ? html`
                              <button
                                class="secondary"
                                @click=${() => this.switchWallet(w.id)}
                              >
                                Switch
                              </button>
                            `
                          : null}
                        ${!isDefault
                          ? html`
                              <button
                                class="danger"
                                ?disabled=${isActive}
                                title=${isActive
                                  ? "Switch to another wallet first to remove this one"
                                  : `Remove ${w.label}`}
                                @click=${() => this.removeWallet(w.id, w.label)}
                              >
                                Remove
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
            placeholder="New wallet label"
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
            placeholder="Rename active wallet"
            .value=${this.renameLabel}
            @input=${(e: Event) =>
              (this.renameLabel = (e.target as HTMLInputElement).value)}
          />
          <button class="secondary" @click=${this.renameWallet}>Rename</button>
        </div>
      </div>

      <div class="card">
        <h3>Security</h3>
        <p>
          No app PIN — this desktop build opens the wallet automatically. Seed
          material is sealed with a desktop-local key (not a user secret); treat
          the app data directory as sensitive.
        </p>
        <div class="row">
          <button @click=${this.doBackup}>Show seed backup</button>
          <button class="danger" @click=${this.wipe}>Wipe wallet</button>
        </div>
        ${this.backup.length
          ? html`
              <div style="margin-top: 12px">
                <p class="words">${this.backup.join(" ")}</p>
                <div class="row">
                  <button class="secondary" @click=${this.copyBackupSeed}>
                    ${this.backupCopied ? "Copied! (clears in 60s)" : "Copy seed phrase"}
                  </button>
                  <button class="secondary" @click=${this.clearBackupDisplay}>
                    Hide seed
                  </button>
                </div>
              </div>
            `
          : null}
      </div>
      <div class="card">
        <h3>About</h3>
        <p>Nighthawk Desktop ${this.appVersion || "3.1.20"} — DarkFi UniFFI + Lit + Tauri</p>
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
