import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { api, type MineStatus, type Prefs } from "../lib/api";

function mineErrorHint(log: string, err: string): string {
  const blob = `${err}\n${log}`.toLowerCase();
  if (blob.includes("wallet configuration is invalid")) {
    return "Stratum rejected the payout address — unlock the wallet and confirm darkfid stratum is on the matching network.";
  }
  if (blob.includes("connection refused") || blob.includes("connect")) {
    return "Cannot reach stratum — start darkfid with stratum enabled (testnet :18347 / mainnet :8347).";
  }
  if (blob.includes("failed to start xmrig") || blob.includes("no such file")) {
    return "xmrig binary missing — run scripts/fetch-xmrig.sh or install xmrig (e.g. Homebrew).";
  }
  if (blob.includes("unlock wallet")) {
    return "Unlock your wallet before mining so payouts go to your deposit address.";
  }
  return "";
}

@customElement("mine-screen")
export class MineScreen extends LitElement {
  @state() private status: MineStatus | null = null;
  @state() private threads = 12;
  @state() private error = "";
  @state() private hint = "";
  private timer?: number;
  private persistTimer?: number;

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
      font-size: 11px;
      color: var(--color-text-muted);
      max-height: 120px;
      overflow: auto;
    }
  `;

  async connectedCallback() {
    super.connectedCallback();
    try {
      const prefs = await api.getPrefs();
      if (prefs.mineThreads) this.threads = prefs.mineThreads;
    } catch {
      /* ignore */
    }
    await this.refresh();
    this.timer = window.setInterval(() => this.refresh(), 5000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.timer) clearInterval(this.timer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
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
          detail: this.status.running ? `Mining ${h}` : "",
          bubbles: true,
          composed: true,
        }),
      );
    } catch (e: any) {
      this.error = String(e);
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
      setTimeout(() => this.refresh(), 2500);
    } catch (e: any) {
      this.error = String(e);
      this.hint = mineErrorHint(this.status?.lastLog || "", this.error);
    }
  }

  private async stop() {
    await api.mineStop();
    await this.refresh();
  }

  render() {
    const s = this.status;
    const hs =
      s?.hashrateHs != null ? `${(s.hashrateHs / 1000).toFixed(2)} kH/s` : "—";
    return html`
      <div class="hero">Mine DRK</div>
      <p class="sub">
        Mines directly to your wallet address via local darkfid stratum.
        Requires darkfid with stratum enabled (testnet :18347 / mainnet :8347).
      </p>
      <div class="card">
        <div>
          Status: <strong>${s?.running ? "Running" : "Stopped"}</strong>
        </div>
        <div>Hashrate: ${hs}</div>
        <label>Threads: ${this.threads} (saved to prefs)</label>
        <input
          type="range"
          min="1"
          max="14"
          .value=${String(this.threads)}
          @input=${this.onThreadsInput}
        />
        <label>Stratum</label>
        <div class="addr">${s?.stratumUrl || "—"}</div>
        <label>Payout address</label>
        <div class="addr">${s?.address || "—"}</div>
        <div class="row">
          <button class="start" @click=${this.start}>Start mining</button>
          <button class="stop" @click=${this.stop}>Stop</button>
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
