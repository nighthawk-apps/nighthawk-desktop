import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { api } from "../lib/api";
import "./app-nav";
import "./status-banner";
import "./onboarding-flow";
import "./wallet-screen";
import "./transfer-flow";
import "./chat-screen";
import "./mine-screen";
import "./settings-screen";

@customElement("main-app")
export class MainApp extends LitElement {
  @state() private phase: "loading" | "onboarding" | "unlock" | "ready" =
    "loading";
  @state() private activeTab = "wallet";
  @state() private network = "testnet";
  @state() private sync = "";
  @state() private mining = "";
  @state() private pin = "";
  @state() private error = "";

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      background: var(--color-moonlit);
      color: var(--color-text-body);
      font-family: var(--font-family-base);
    }
    main {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
    }
    .center {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 12px;
      padding: 24px;
    }
    input {
      padding: 12px 14px;
      border-radius: var(--border-radius-md);
      border: 1px solid var(--color-steel-border);
      background: var(--color-elevated);
      color: var(--color-text-header);
      font-family: inherit;
      width: min(280px, 100%);
    }
    button {
      padding: 12px 18px;
      border: none;
      border-radius: var(--border-radius-md);
      background: var(--color-accent);
      color: var(--color-on-accent);
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    .err {
      color: var(--color-dangerous);
    }
  `;

  async connectedCallback() {
    super.connectedCallback();
    // Paint unlock/onboarding UI immediately; never leave blank "loading".
    this.phase = "unlock";
    try {
      const exists = await api.walletExists();
      const status = await api.appStatus();
      this.network = status.network;
      if (!exists) this.phase = "onboarding";
      else if (!status.walletOpen) this.phase = "unlock";
      else this.phase = "ready";
    } catch (e: any) {
      this.error = String(e);
      this.phase = "onboarding";
    }
  }

  private async unlock() {
    this.error = "";
    try {
      await api.unlockWallet(this.pin);
      this.phase = "ready";
      const prefs = await api.getPrefs();
      this.network = prefs.network;
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private content() {
    switch (this.activeTab) {
      case "chat":
        return html`<chat-screen></chat-screen>`;
      case "transfer":
        return html`<transfer-flow></transfer-flow>`;
      case "mine":
        return html`<mine-screen
          @mine-update=${(e: CustomEvent) => (this.mining = e.detail)}
        ></mine-screen>`;
      case "settings":
        return html`<settings-screen
          @prefs-changed=${async () => {
            const p = await api.getPrefs();
            this.network = p.network;
          }}
        ></settings-screen>`;
      default:
        return html`<wallet-screen
          @sync-update=${(e: CustomEvent) => (this.sync = e.detail)}
        ></wallet-screen>`;
    }
  }

  render() {
    if (this.phase === "loading") {
      return html`<div class="center">Starting Nighthawk…</div>`;
    }
    if (this.phase === "onboarding") {
      return html`<onboarding-flow
        @wallet-ready=${() => {
          this.phase = "ready";
        }}
      ></onboarding-flow>`;
    }
    if (this.phase === "unlock") {
      return html`
        <div class="center">
          <h2>Unlock wallet</h2>
          <input
            type="password"
            inputmode="numeric"
            placeholder="PIN"
            .value=${this.pin}
            @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.unlock()}
            @input=${(e: Event) =>
              (this.pin = (e.target as HTMLInputElement).value)}
          />
          <button @click=${this.unlock}>Unlock</button>
          ${this.error ? html`<p class="err">${this.error}</p>` : null}
        </div>
      `;
    }
    return html`
      <status-banner
        network=${this.network}
        sync=${this.sync}
        mining=${this.mining}
      ></status-banner>
      <main>${this.content()}</main>
      <app-nav
        active=${this.activeTab}
        @tab-change=${(e: CustomEvent) => (this.activeTab = e.detail)}
      ></app-nav>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "main-app": MainApp;
  }
}
