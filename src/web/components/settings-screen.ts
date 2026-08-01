import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  api,
  prefsFeeTier,
  type DaoProposalSummary,
  type DaoSummary,
  type FeeTier,
  type Network,
  type Prefs,
  type WalletProfiles,
} from "../lib/api";

@customElement("settings-screen")
export class SettingsScreen extends LitElement {
  @state() private prefs: Prefs | null = null;
  @state() private pin = "";
  @state() private backup: string[] = [];
  @state() private message = "";
  @state() private error = "";
  @state() private artiRunning = false;
  @state() private wallets: WalletProfiles | null = null;
  @state() private newWalletLabel = "";
  @state() private daos: DaoSummary[] = [];
  @state() private proposals: DaoProposalSummary[] = [];
  @state() private selectedDao = "";
  @state() private proposeAmount = "";
  @state() private proposeRecipient = "";
  @state() private proposeDuration = "10";
  @state() private proposeTokenId = "";

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
    .dao {
      font-size: var(--font-size-sm);
      padding: 8px 0;
      border-bottom: 1px solid var(--color-steel-border-muted);
    }
  `;

  async connectedCallback() {
    super.connectedCallback();
    this.prefs = await api.getPrefs();
    this.artiRunning = await api.artiStatus();
    this.wallets = await api.walletsList();
    try {
      this.daos = await api.listDaos();
    } catch {
      this.daos = [];
    }
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
      this.message = `Network set to ${n}. Re-unlock wallet if needed.`;
      this.dispatchEvent(
        new CustomEvent("prefs-changed", { bubbles: true, composed: true }),
      );
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async doBackup() {
    try {
      this.backup = await api.backupMnemonic(this.pin);
      this.message = "Seed unlocked — store safely";
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async wipe() {
    if (!confirm("Wipe all wallet data on this device?")) return;
    try {
      await api.wipeWallet(this.pin);
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
        "New wallet profile created — complete onboarding / restore, then unlock.";
      location.reload();
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async switchWallet(id: string) {
    try {
      await api.walletsSwitch(id);
      this.message = "Switched wallet — unlock with that profile’s PIN";
      location.reload();
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async loadProposals(name: string) {
    this.selectedDao = name;
    try {
      this.proposals = await api.listProposals(name);
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async vote(bulla: string, yes: boolean) {
    try {
      const tx = await api.daoVote(bulla, yes);
      this.message = `Vote broadcast: ${tx}`;
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async proposeTransfer() {
    if (!this.selectedDao || !this.proposeAmount.trim() || !this.proposeRecipient.trim()) {
      this.error = "Select a DAO and fill amount + recipient";
      return;
    }
    try {
      const tx = await api.daoProposeTransfer({
        daoName: this.selectedDao,
        durationBlockwindows: Number(this.proposeDuration) || 10,
        amount: this.proposeAmount.trim(),
        tokenId: this.proposeTokenId || undefined,
        recipientAddress: this.proposeRecipient.trim(),
      });
      this.message = `Propose broadcast: ${tx}`;
      await this.loadProposals(this.selectedDao);
    } catch (e: any) {
      this.error = String(e);
    }
  }

  render() {
    const p = this.prefs;
    if (!p) return html`<p>Loading…</p>`;
    const tier = prefsFeeTier(p);
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
        <label>Fee preference</label>
        <select
          .value=${tier}
          @change=${(e: Event) => {
            p.feeTier = (e.target as HTMLSelectElement).value as FeeTier;
            this.requestUpdate();
          }}
        >
          <option value="economy">Economy</option>
          <option value="normal">Normal</option>
          <option value="priority">Priority</option>
        </select>
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
      </div>

      <div class="card">
        <h3>DAO</h3>
        ${this.daos.length === 0
          ? html`<p class="msg">No DAOs imported in this wallet yet.</p>`
          : this.daos.map(
              (d) => html`
                <div class="dao">
                  <strong>${d.name}</strong>
                  <div class="msg">
                    quorum ${d.quorumDisplay} · approval
                    ${d.approvalRatioPercent.toFixed(1)}%
                  </div>
                  <button
                    class="secondary"
                    @click=${() => this.loadProposals(d.name)}
                  >
                    Proposals
                  </button>
                </div>
              `,
            )}
        ${this.selectedDao
          ? html`
              <h4>Propose transfer — ${this.selectedDao}</h4>
              <label>Amount</label>
              <input
                .value=${this.proposeAmount}
                @input=${(e: Event) =>
                  (this.proposeAmount = (e.target as HTMLInputElement).value)}
              />
              <label>Recipient</label>
              <input
                .value=${this.proposeRecipient}
                @input=${(e: Event) =>
                  (this.proposeRecipient = (e.target as HTMLInputElement).value)}
              />
              <label>Duration (blockwindows)</label>
              <input
                .value=${this.proposeDuration}
                @input=${(e: Event) =>
                  (this.proposeDuration = (e.target as HTMLInputElement).value)}
              />
              <label>Token id (optional)</label>
              <input
                .value=${this.proposeTokenId}
                @input=${(e: Event) =>
                  (this.proposeTokenId = (e.target as HTMLInputElement).value)}
              />
              <button class="secondary" @click=${this.proposeTransfer}>
                Propose transfer
              </button>
              <h4>${this.selectedDao} proposals</h4>
              ${this.proposals.map(
                (pr) => html`
                  <div class="dao">
                    <div>${pr.summaryLine || pr.proposalBullaB58}</div>
                    <button
                      class="secondary"
                      @click=${() => this.vote(pr.proposalBullaB58, true)}
                    >
                      Yes
                    </button>
                    <button
                      class="secondary"
                      @click=${() => this.vote(pr.proposalBullaB58, false)}
                    >
                      No
                    </button>
                  </div>
                `,
              )}
            `
          : null}
      </div>

      <div class="card">
        <h3>Security</h3>
        <label>PIN</label>
        <input
          type="password"
          .value=${this.pin}
          @input=${(e: Event) =>
            (this.pin = (e.target as HTMLInputElement).value)}
        />
        <button @click=${this.doBackup}>Show seed backup</button>
        <button class="danger" @click=${this.wipe}>Wipe wallet</button>
        ${this.backup.length
          ? html`<p class="words">${this.backup.join(" ")}</p>`
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
