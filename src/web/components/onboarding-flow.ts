import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { api, formatInvokeError, type Network } from "../lib/api";
import { t } from "../i18n";

@customElement("onboarding-flow")
export class OnboardingFlow extends LitElement {
  @state() private step: "welcome" | "create" | "restore" = "welcome";
  @state() private network: Network = "testnet";
  @state() private mnemonic: string[] = [];
  @state() private restoreText = "";
  @state() private birthday = 0;
  @state() private error = "";
  @state() private busy = false;
  @state() private checkingExisting = true;
  private mode: "create" | "restore" = "create";

  override async connectedCallback() {
    super.connectedCallback();
    await this.enterExistingWallet();
  }

  /** Vault on disk means this device already has a wallet — open it. */
  private async enterExistingWallet(): Promise<boolean> {
    try {
      if (!(await api.walletExists())) {
        this.checkingExisting = false;
        return false;
      }
      await api.openWallet();
      this.dispatchEvent(
        new CustomEvent("wallet-ready", { bubbles: true, composed: true }),
      );
      return true;
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
      this.checkingExisting = false;
      return false;
    }
  }

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
    }
    .card {
      width: min(480px, 100%);
      background: var(--color-charcoal-raised);
      border: 1px solid var(--color-steel-border);
      border-radius: var(--border-radius-xl);
      padding: 28px;
    }
    h1 {
      font-size: var(--font-size-2xl);
      margin-bottom: 8px;
    }
    p {
      color: var(--color-text-muted);
      margin-top: 0;
    }
    .actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 20px;
    }
    button,
    select,
    input,
    textarea {
      font-family: inherit;
      font-size: var(--font-size-md);
      border-radius: var(--border-radius-md);
      border: 1px solid var(--color-steel-border);
      background: var(--color-elevated);
      color: var(--color-text-header);
      padding: 12px 14px;
    }
    button.primary {
      background: var(--color-accent);
      color: var(--color-on-accent);
      border: none;
      font-weight: 600;
      cursor: pointer;
    }
    button.secondary {
      background: var(--color-secondary-fill);
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .words {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      font-size: var(--font-size-sm);
      margin: 12px 0;
      max-height: 220px;
      overflow: auto;
    }
    .err {
      color: var(--color-dangerous);
      font-size: var(--font-size-sm);
    }
    label {
      display: block;
      margin-top: 12px;
      color: var(--color-text-muted);
      font-size: var(--font-size-sm);
    }
  `;

  private async startCreate() {
    this.error = "";
    this.busy = true;
    try {
      this.mnemonic = await api.generateMnemonic();
      this.mode = "create";
      this.step = "create";
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    } finally {
      this.busy = false;
    }
  }

  private startRestore() {
    this.mode = "restore";
    this.step = "restore";
  }

  private async finish() {
    this.error = "";
    if (this.mode === "restore") {
      this.mnemonic = this.restoreText
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (this.mnemonic.length < 12) {
        this.error = t("onboarding.enter_full_seed");
        return;
      }
    }
    this.busy = true;
    try {
      const args = {
        mnemonic: this.mnemonic,
        network: this.network,
        birthdayHeight:
          this.mode === "create"
            ? 0
            : this.birthday > 0
              ? this.birthday
              : -1,
      };
      if (this.mode === "create") await api.createWallet(args);
      else await api.restoreWallet(args);
      this.dispatchEvent(
        new CustomEvent("wallet-ready", { bubbles: true, composed: true }),
      );
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
      if (/already exists/i.test(this.error)) {
        await this.enterExistingWallet();
      }
    } finally {
      this.busy = false;
    }
  }

  render() {
    if (this.checkingExisting) {
      return html`<div class="card">
        <h1>${t("app.name")}</h1>
        <p>${t("onboarding.opening_wallet")}</p>
      </div>`;
    }
    return html`
      <div class="card">
        ${this.step === "welcome"
          ? html`
              <h1>${t("app.name")}</h1>
              <p>${t("onboarding.tagline")}</p>
              <label>${t("network.label")}</label>
              <select
                .value=${this.network}
                @change=${(e: Event) =>
                  (this.network = (e.target as HTMLSelectElement).value as Network)}
              >
                <option value="testnet">${t("onboarding.testnet_label")}</option>
                <option value="mainnet">${t("network.mainnet")}</option>
              </select>
              <div class="actions">
                <button class="primary" ?disabled=${this.busy} @click=${this.startCreate}>
                  ${t("wallet.create")}
                </button>
                <button class="secondary" @click=${this.startRestore}>
                  ${t("onboarding.restore_from_seed")}
                </button>
              </div>
            `
          : null}
        ${this.step === "create"
          ? html`
              <h1>${t("wallet.backup_seed")}</h1>
              <p>${t("onboarding.backup_hint")}</p>
              <div class="words">
                ${this.mnemonic.map((w, i) => html`<div>${i + 1}. ${w}</div>`)}
              </div>
              <div class="actions">
                <button class="primary" ?disabled=${this.busy} @click=${this.finish}>
                  ${this.busy ? t("common.creating") : t("common.finish")}
                </button>
                <button class="secondary" @click=${() => (this.step = "welcome")}>
                  ${t("common.back")}
                </button>
              </div>
            `
          : null}
        ${this.step === "restore"
          ? html`
              <h1>${t("onboarding.restore_title")}</h1>
              <textarea
                rows="5"
                placeholder=${t("onboarding.seed_placeholder")}
                .value=${this.restoreText}
                @input=${(e: Event) =>
                  (this.restoreText = (e.target as HTMLTextAreaElement).value)}
              ></textarea>
              <label>${t("wallet.birthday")}</label>
              <input
                type="number"
                .value=${String(this.birthday)}
                @input=${(e: Event) =>
                  (this.birthday = Number((e.target as HTMLInputElement).value) || 0)}
              />
              <div class="actions">
                <button class="primary" ?disabled=${this.busy} @click=${this.finish}>
                  ${this.busy ? t("onboarding.restoring") : t("onboarding.restore_wallet")}
                </button>
                <button class="secondary" @click=${() => (this.step = "welcome")}>
                  ${t("common.back")}
                </button>
              </div>
            `
          : null}
        ${this.error ? html`<p class="err">${this.error}</p>` : null}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "onboarding-flow": OnboardingFlow;
  }
}
