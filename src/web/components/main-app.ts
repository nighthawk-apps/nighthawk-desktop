import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { api, formatInvokeError } from "../lib/api";
import "./onboarding-flow";

@customElement("main-app")
export class MainApp extends LitElement {
  @state() private phase: "loading" | "onboarding" | "ready" = "loading";
  @state() private activeTab = "wallet";
  @state() private network = "testnet";
  @state() private sync = "";
  @state() private mining = "";
  @state() private error = "";
  @state() private screensReady = false;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      height: 100dvh;
      background: var(--color-moonlit, #0e1012);
      color: var(--color-text-body, #c4cbd4);
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
      background: var(--color-moonlit, #0e1012);
    }
    .err {
      color: var(--color-dangerous);
      max-width: 320px;
      text-align: center;
    }
  `;

  async connectedCallback() {
    super.connectedCallback();
    this.phase = "loading";
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    try {
      const exists = await api.walletExists();
      const status = await api.appStatus();
      this.network = status.network;
      if (!exists) {
        this.phase = "onboarding";
        return;
      }
      if (!status.walletOpen) {
        await api.openWallet();
      }
      await this.ensureScreens();
      this.phase = "ready";
      const prefs = await api.getPrefs();
      this.network = prefs.network;
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
      // Broken / PIN-era vault → start fresh.
      this.phase = "onboarding";
    }
  }

  private async ensureScreens() {
    if (this.screensReady) return;
    await Promise.all([
      import("./app-nav"),
      import("./status-banner"),
      import("./wallet-screen"),
      import("./transfer-flow"),
      import("./chat-screen"),
      import("./mine-screen"),
      import("./settings-screen"),
    ]);
    this.screensReady = true;
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
      return html`<div class="center">
        Starting Nighthawk…
        ${this.error ? html`<p class="err">${this.error}</p>` : null}
      </div>`;
    }
    if (this.phase === "onboarding") {
      return html`<onboarding-flow
        @wallet-ready=${async () => {
          await this.ensureScreens();
          this.phase = "ready";
        }}
      ></onboarding-flow>`;
    }
    if (!this.screensReady) {
      return html`<div class="center">Loading wallet…</div>`;
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
