import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { api, formatInvokeError } from "../lib/api";
import { formatLightSyncBanner } from "../lib/sync-label";
import { t } from "../i18n";
import "./onboarding-flow";

@customElement("main-app")
export class MainApp extends LitElement {
  @state() private phase:
    | "loading"
    | "onboarding"
    | "unlock-error"
    | "ready" = "loading";
  @state() private activeTab = "chat";
  @state() private transferTab: "request" | "receive" | "send" = "receive";
  @state() private settingsMode: "settings" | "chat" = "settings";
  @state() private network = "testnet";
  @state() private sync = "";
  @state() private mining = "";
  @state() private error = "";
  @state() private screensReady = false;
  @state() private localeTick = 0;
  private syncTimer?: number;
  private onLocale = () => {
    this.localeTick++;
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      height: 100dvh;
      background: var(--color-moonlit, #0e1012);
      color: var(--color-text-body, #c4cbd4);
      font-family: var(--font-family-base);
      font-size: 1rem;
      line-height: 1.45;
      letter-spacing: 0.01em;
    }
    main {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
    }
    chat-screen[hidden] {
      display: none;
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
    button {
      margin-top: 8px;
      padding: 10px 14px;
      border: none;
      border-radius: var(--border-radius-md, 8px);
      background: var(--color-accent);
      color: var(--color-on-accent);
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
  `;

  async connectedCallback() {
    super.connectedCallback();
    window.addEventListener("nh-locale-changed", this.onLocale);
    this.phase = "loading";
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    let exists = false;
    try {
      exists = await api.walletExists();
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
      this.startSyncPolling();
      const prefs = await api.getPrefs();
      this.network = prefs.network;
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
      // Existing vault must never fall through to Create (that overwrites vault.dat).
      this.phase = exists ? "unlock-error" : "onboarding";
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("nh-locale-changed", this.onLocale);
    if (this.syncTimer) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
  }

  private startSyncPolling() {
    if (this.syncTimer) window.clearInterval(this.syncTimer);
    void this.pollLightSync();
    this.syncTimer = window.setInterval(() => void this.pollLightSync(), 4000);
  }

  private async pollLightSync() {
    try {
      const snap = await api.walletLightSync();
      this.sync = formatLightSyncBanner(snap);
      window.dispatchEvent(
        new CustomEvent("nighthawk-sync-updated", { detail: snap }),
      );
    } catch {
      /* ignore transient background sync poll errors */
    }
  }

  private async retryUnlock() {
    this.error = "";
    this.phase = "loading";
    try {
      await api.openWallet();
      await this.ensureScreens();
      this.phase = "ready";
      this.startSyncPolling();
      const prefs = await api.getPrefs();
      this.network = prefs.network;
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
      this.phase = "unlock-error";
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
      import("./dex-screen"),
      import("./dao-screen"),
      import("./mine-screen"),
      import("./settings-screen"),
    ]);
    this.screensReady = true;
  }

  private openSettings(mode: "settings" | "chat" = "settings") {
    this.settingsMode = mode;
    this.activeTab = "settings";
  }

  private otherContent() {
    switch (this.activeTab) {
      case "chat":
        return null;
      case "transfer":
        return html`<transfer-flow .initialTab=${this.transferTab}></transfer-flow>`;
      case "dex":
        return html`<dex-screen></dex-screen>`;
      case "dao":
        return html`<dao-screen></dao-screen>`;
      case "mine":
        return html`<mine-screen
          @mine-update=${(e: CustomEvent) => (this.mining = e.detail)}
        ></mine-screen>`;
      case "settings":
        return html`<settings-screen
          .screenTitle=${this.settingsMode === "chat"
            ? t("chat.settings")
            : t("nav.settings")}
          @prefs-changed=${async () => {
            const p = await api.getPrefs();
            this.network = p.network;
            const st = await api.appStatus().catch(() => null);
            if (st && !st.walletOpen && (await api.walletExists().catch(() => false))) {
              await api.openWallet().catch(() => undefined);
            }
          }}
        ></settings-screen>`;
      default:
        return html`<wallet-screen
          @sync-update=${(e: CustomEvent) => (this.sync = e.detail)}
          @open-transfer=${(e: CustomEvent<"request" | "receive" | "send">) => {
            this.transferTab = e.detail;
            this.activeTab = "transfer";
          }}
        ></wallet-screen>`;
    }
  }

  render() {
    void this.localeTick;
    if (this.phase === "loading") {
      return html`<div class="center">
        ${t("app.starting")}
        ${this.error ? html`<p class="err">${this.error}</p>` : null}
      </div>`;
    }
    if (this.phase === "unlock-error") {
      return html`<div class="center">
        <p class="err">${t("wallet.could_not_open")}</p>
        ${this.error ? html`<p class="err">${this.error}</p>` : null}
        <button @click=${() => this.retryUnlock()}>${t("common.retry")}</button>
      </div>`;
    }
    if (this.phase === "onboarding") {
      return html`<onboarding-flow
        @wallet-ready=${async () => {
          await this.ensureScreens();
          this.phase = "ready";
          this.startSyncPolling();
        }}
      ></onboarding-flow>`;
    }
    if (!this.screensReady) {
      return html`<div class="center">${t("common.loading_wallet")}</div>`;
    }
    return html`
      <status-banner
        network=${this.network}
        sync=${this.sync}
        mining=${this.mining}
      ></status-banner>
      <main>
        <chat-screen
          ?hidden=${this.activeTab !== "chat"}
          @open-chat-settings=${() => this.openSettings("chat")}
          @open-transfer=${(e: CustomEvent<"request" | "receive" | "send">) => {
            this.transferTab = e.detail;
            this.activeTab = "transfer";
          }}
        ></chat-screen>
        ${this.otherContent()}
      </main>
      <app-nav
        active=${this.activeTab === "transfer" ? "wallet" : this.activeTab}
        @tab-change=${(e: CustomEvent) => {
          const tab = e.detail as string;
          this.activeTab = tab;
          if (tab === "settings") {
            this.settingsMode = "settings";
          }
        }}
      ></app-nav>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "main-app": MainApp;
  }
}
