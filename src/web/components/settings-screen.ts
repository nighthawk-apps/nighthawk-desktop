import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  api,
  type Network,
  type Prefs,
  type WalletProfiles,
} from "../lib/api";

@customElement("settings-screen")
export class SettingsScreen extends LitElement {
  @state() private prefs: Prefs | null = null;
  @state() private backup: string[] = [];
  @state() private backupCopied = false;
  @state() private message = "";
  @state() private error = "";
  @state() private artiRunning = false;
  @state() private wallets: WalletProfiles | null = null;
  @state() private newWalletLabel = "";
  @state() private renameLabel = "";

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
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
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
  }

  private async save() {
    if (!this.prefs) return;
    this.error = "";
    try {
      await api.setPrefs(this.prefs);
      this.message = "Preferences saved";
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async switchNetwork(n: Network) {
    try {
      await api.setNetwork(n);
      this.prefs = await api.getPrefs();
      this.message = `Network set to ${n}. Restart if balances look stale.`;
      this.dispatchEvent(
        new CustomEvent("prefs-changed", { bubbles: true, composed: true }),
      );
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async doBackup() {
    try {
      this.backup = await api.backupMnemonic();
      this.message = "Seed shown — store safely";
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async wipe() {
    if (!confirm("Wipe all wallet data on this device?")) return;
    try {
      await api.wipeWallet();
      location.reload();
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async toggleArti() {
    try {
      if (this.artiRunning) {
        await api.artiStop();
      } else {
        await api.artiStart();
      }
      this.artiRunning = await api.artiStatus();
      this.message = this.artiRunning ? "Arti Tor proxy started" : "Arti stopped";
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async createWalletProfile() {
    try {
      await api.walletsCreate(this.newWalletLabel || "New wallet");
      this.wallets = await api.walletsList();
      this.message =
        "New wallet profile created — complete onboarding / restore.";
      location.reload();
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async switchWallet(id: string) {
    try {
      await api.walletsSwitch(id);
      this.message = "Switched wallet — reloading…";
      location.reload();
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async renameWallet() {
    if (!this.wallets) return;
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
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async removeWallet() {
    if (!this.wallets) return;
    const id = this.wallets.activeId;
    if (id === "default") {
      this.error = "Cannot remove the default wallet profile — use Wipe instead";
      return;
    }
    if (
      !confirm(
        `Remove wallet profile "${id}"? This deletes that profile’s vault data.`,
      )
    ) {
      return;
    }
    try {
      await api.walletsRemove(id);
      this.wallets = await api.walletsList();
      this.message = "Wallet profile removed — reloading…";
      location.reload();
    } catch (e: any) {
      this.error = String(e);
    }
  }

  render() {
    const p = this.prefs;
    if (!p) return html`<p>Loading…</p>`;
    return html`
      <div class="card">
        <h3>Network</h3>
        <select
          .value=${p.network}
          @change=${(e: Event) =>
            this.switchNetwork((e.target as HTMLSelectElement).value as Network)}
        >
          <option value="testnet">Testnet</option>
          <option value="mainnet">Mainnet</option>
        </select>
        <label>Lightwalletd URL</label>
        <input
          .value=${p.lightwalletUrl}
          @input=${(e: Event) => {
            p.lightwalletUrl = (e.target as HTMLInputElement).value;
            this.requestUpdate();
          }}
        />
        <label>LWD TLS pin (SHA-256 hex of leaf cert DER)</label>
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
        <label>Tor SOCKS port</label>
        <input
          type="number"
          .value=${String(p.torSocksPort)}
          @input=${(e: Event) => {
            p.torSocksPort = Number((e.target as HTMLInputElement).value) || 9050;
            this.requestUpdate();
          }}
        />
        <label>
          <input
            type="checkbox"
            .checked=${p.useTor}
            @change=${(e: Event) => {
              p.useTor = (e.target as HTMLInputElement).checked;
              this.requestUpdate();
            }}
          />
          Use Tor for chat / LWD when supported
        </label>
        <label>
          <input
            type="checkbox"
            .checked=${p.strictOmrOnly}
            @change=${(e: Event) => {
              p.strictOmrOnly = (e.target as HTMLInputElement).checked;
              this.requestUpdate();
            }}
          />
          Strict UnifOMR sync (no trial-decrypt fallback)
        </label>
        <p class="msg">
          Off by default so you can receive from non-UnifOMR wallets (e.g.
          <code>drk</code>). When on, only payments with UnifOMR clues are discovered —
          faster and more private, but <code>drk</code> sends may not appear.
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
              <select
                .value=${this.wallets.activeId}
                @change=${(e: Event) =>
                  this.switchWallet((e.target as HTMLSelectElement).value)}
              >
                ${this.wallets.wallets.map(
                  (w) =>
                    html`<option value=${w.id}>
                      ${w.label}${w.id === this.wallets!.activeId
                        ? " (active)"
                        : ""}
                    </option>`,
                )}
              </select>
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
            Add wallet
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
          <button class="danger" @click=${this.removeWallet}>
            Remove active
          </button>
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
                <button
                  class="secondary"
                  @click=${() => {
                    navigator.clipboard.writeText(this.backup.join(" "));
                    this.backupCopied = true;
                    setTimeout(() => (this.backupCopied = false), 2000);
                  }}
                >
                  ${this.backupCopied ? "Copied!" : "Copy seed phrase"}
                </button>
              </div>
            `
          : null}
      </div>
      <div class="card">
        <h3>About</h3>
        <p>Nighthawk Desktop 0.1.0 — DarkFi UniFFI + Lit + Tauri</p>
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
