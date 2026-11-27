import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { api, formatInvokeError, type MineStatus, type Prefs } from "../lib/api";
import { t } from "../i18n";

function mineErrorHint(log: string, err: string): string {
  const blob = `${err}\n${log}`.toLowerCase();
  if (blob.includes("wallet configuration is invalid")) {
    return t("mine.hint_invalid_wallet");
  }
  if (blob.includes("connection refused") || blob.includes("connect")) {
    return t("mine.hint_stratum_refused");
  }
  if (
    blob.includes("failed to start xmrig") ||
    blob.includes("bundled xmrig") ||
    blob.includes("not a known nighthawk build") ||
    blob.includes("no such file")
  ) {
    return t("mine.hint_xmrig_missing");
  }
  if (blob.includes("unlock wallet")) {
    return t("mine.hint_unlock_wallet");
  }
  return "";
}

@customElement("mine-screen")
export class MineScreen extends LitElement {
  @state() private status: MineStatus | null = null;
  @state() private threads = 12;
  @state() private error = "";
  @state() private hint = "";
  @state() private localeTick = 0;
  private timer?: number;
  private persistTimer?: number;
  private onLocale = () => {
    this.localeTick++;
  };

  static styles = css`
    :host {
      display: block;
      padding: 20px;
    }
    .hero {
      font-size: var(--font-size-2xl);
      color: var(--color-text-header);
      font-weight: 700;
    }
    .sub {
      color: var(--color-text-muted);
      font-size: var(--font-size-sm);
      margin-bottom: 16px;
    }
    .card {
      background: var(--color-charcoal-raised);
      border: 1px solid var(--color-steel-border-muted);
      border-radius: var(--border-radius-lg);
      padding: 16px;
      margin-bottom: 12px;
    }
    label {
      display: block;
      font-size: var(--font-size-sm);
      color: var(--color-text-muted);
      margin-top: 10px;
    }
    input[type="range"] {
      width: 100%;
    }
    .addr {
      word-break: break-all;
      color: var(--color-accent-muted);
      font-size: var(--font-size-sm);
    }
    .row {
      display: flex;
      gap: 8px;
      margin-top: 16px;
    }
    button {
      flex: 1;
      padding: 12px;
      border: none;
      border-radius: var(--border-radius-md);
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    .start {
      background: var(--color-accent);
      color: var(--color-on-accent);
    }
    .stop {
      background: var(--color-dangerous-banner-bg);
      color: var(--color-dangerous-banner-fg);
    }
    .err {
      color: var(--color-dangerous);
    }
    .hint {
      color: var(--color-warning, #e0a84a);
      font-size: var(--font-size-sm);
      margin-top: 8px;
    }
    pre {
      white-space: pre-wrap;
      font-family: var(--font-family-mono);
      font-size: var(--font-size-xs);
      line-height: 1.45;
      color: var(--color-text-muted);
      max-height: 120px;
      overflow: auto;
    }
  `;

  private startRefreshTimer?: number;

  async connectedCallback() {
    super.connectedCallback();
    window.addEventListener("nh-locale-changed", this.onLocale);
    try {
      const prefs = await api.getPrefs();
      if (!this.isConnected) return;
      if (prefs.mineThreads) this.threads = prefs.mineThreads;
    } catch {
      /* ignore */
    }
    await this.refresh();
    if (!this.isConnected) return;
    this.timer = window.setInterval(() => this.refresh(), 5000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("nh-locale-changed", this.onLocale);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (this.startRefreshTimer) {
      clearTimeout(this.startRefreshTimer);
      this.startRefreshTimer = undefined;
    }
  }

  private onThreadsInput(e: Event) {
    this.threads = Number((e.target as HTMLInputElement).value);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => this.persistThreads(), 400);
  }

  private async persistThreads() {
    try {
      const prefs = await api.getPrefs();
      (prefs as Prefs).mineThreads = this.threads;
      await api.setPrefs(prefs);
    } catch {
      /* ignore */
    }
  }

  private async refresh() {
    try {
      this.status = await api.mineStatus();
      this.threads = this.status.threads || this.threads;
      const log = this.status.lastLog || "";
      if (this.status.running) {
        this.hint = mineErrorHint(log, "");
      } else if (log) {
        this.hint = mineErrorHint(log, this.error);
      }
      const h =
        this.status.hashrateHs != null
          ? `${(this.status.hashrateHs / 1000).toFixed(1)} kH/s`
          : "";
      this.dispatchEvent(
        new CustomEvent("mine-update", {
          detail: this.status.running ? t("mine.banner_mining", { rate: h }).trim() : "",
          bubbles: true,
          composed: true,
        }),
      );
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
      this.hint = mineErrorHint(this.status?.lastLog || "", this.error);
    }
  }

  private async start() {
    this.error = "";
    this.hint = "";
    try {
      await this.persistThreads();
      await api.mineStart(this.threads);
      await this.refresh();
      // Surface stratum rejection quickly from the first log lines
      if (this.startRefreshTimer) clearTimeout(this.startRefreshTimer);
      this.startRefreshTimer = window.setTimeout(() => this.refresh(), 2500);
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
      this.hint = mineErrorHint(this.status?.lastLog || "", this.error);
    }
  }

  private async stop() {
    this.error = "";
    try {
      await api.mineStop();
      await this.refresh();
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  render() {
    void this.localeTick;
    const s = this.status;
    const hs =
      s?.hashrateHs != null ? `${(s.hashrateHs / 1000).toFixed(2)} kH/s` : "—";
    return html`
      <div class="hero">${t("mine.title")}</div>
      <p class="sub">${t("mine.subtitle")}</p>
      <div class="card">
        <div>
          ${t("mine.status_label")}
          <strong>${s?.running ? t("mine.running") : t("mine.stopped")}</strong>
        </div>
        <div>${t("mine.hashrate_label")} ${hs}</div>
        <label>${t("mine.threads_label", { threads: this.threads })}</label>
        <input
          type="range"
          min="1"
          max="64"
          .value=${String(this.threads)}
          @input=${this.onThreadsInput}
        />
        <label>${t("mine.stratum_label")}</label>
        <div class="addr">${s?.stratumUrl || "—"}</div>
        <label>${t("mine.payout_address")}</label>
        <div class="addr">${s?.address || "—"}</div>
        <div class="row">
          <button class="start" @click=${this.start}>
            ${t("mine.start_mining")}
          </button>
          <button class="stop" @click=${this.stop}>${t("common.stop")}</button>
        </div>
        ${this.hint ? html`<p class="hint">${this.hint}</p>` : null}
      </div>
      ${s?.lastLog ? html`<div class="card"><pre>${s.lastLog}</pre></div>` : null}
      ${this.error ? html`<p class="err">${this.error}</p>` : null}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "mine-screen": MineScreen;
  }
}
