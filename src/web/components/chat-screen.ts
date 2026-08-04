import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { api, type ChatMessage, type DmKeypair } from "../lib/api";
import type { UnlistenFn } from "@tauri-apps/api/event";

const CHANNELS = ["#dev", "#memes", "#random", "#markets", "#philosophy"];

@customElement("chat-screen")
export class ChatScreen extends LitElement {
  @state() private channel = "#dev";
  @state() private channelsList = [...CHANNELS];
  @state() private status = "stopped";
  @state() private messages: ChatMessage[] = [];
  @state() private draft = "";
  @state() private error = "";
  @state() private dmKeys: DmKeypair | null = null;
  @state() private peerPublic = "";
  @state() private dmMode = false;
  @state() private decryptedHint = "";
  @state() private toastMessage = "";
  private unlisten?: UnlistenFn;
  private toastTimer?: number;
  private touchTimer?: number;
  private statusPoll?: number;

  private static phaseLabel(phase: string): string {
    switch (phase) {
      case "starting":
        return "Starting…";
      case "waiting_for_peers":
        return "Finding peers…";
      case "static_sync":
        return "Static sync…";
      case "syncing_dag":
        return "Syncing DAG…";
      case "loading_history":
        return "Loading history…";
      case "connected":
      case "running":
        return "Connected";
      case "stopping":
        return "Stopping…";
      case "failed":
        return "Failed";
      case "not_running":
      case "stopped":
      default:
        return "Stopped";
    }
  }

  private static phaseClass(phase: string): string {
    switch (phase) {
      case "connected":
      case "running":
        return "ok";
      case "failed":
        return "bad";
      case "stopped":
      case "not_running":
        return "";
      default:
        return "busy";
    }
  }

  private isTerminalPhase(phase: string): boolean {
    return (
      phase === "stopped" ||
      phase === "not_running" ||
      phase === "connected" ||
      phase === "failed"
    );
  }

  private stopStatusPoll() {
    if (this.statusPoll) {
      window.clearInterval(this.statusPoll);
      this.statusPoll = undefined;
    }
  }

  private startStatusPoll() {
    this.stopStatusPoll();
    this.statusPoll = window.setInterval(async () => {
      try {
        const next = await api.chatStatus();
        this.status = next;
        // Keep polling while connected so peer loss / resync updates the label.
        if (next === "stopped" || next === "not_running" || next === "failed") {
          this.stopStatusPoll();
        }
      } catch {
        /* ignore transient poll errors */
      }
    }, 500);
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      padding: 12px 16px;
      box-sizing: border-box;
    }
    .top {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }
    select,
    button,
    input {
      font-family: inherit;
      border-radius: var(--border-radius-md);
      border: 1px solid var(--color-steel-border);
      background: var(--color-elevated);
      color: var(--color-text-header);
      padding: 8px 10px;
    }
    button.primary {
      background: var(--color-accent);
      color: var(--color-on-accent);
      border: none;
      font-weight: 600;
      cursor: pointer;
    }
    .msgs {
      flex: 1;
      overflow-y: auto;
      background: var(--color-ink-panel);
      border-radius: var(--border-radius-md);
      padding: 12px;
      font-size: var(--font-size-sm);
      user-select: text;
      -webkit-user-select: text;
    }
    .m {
      margin-bottom: 8px;
      user-select: text;
      -webkit-user-select: text;
      cursor: pointer;
      padding: 4px 6px;
      border-radius: 6px;
      transition: background 0.15s ease;
    }
    .m:hover {
      background: rgba(255, 255, 255, 0.05);
    }
    .m .content {
      user-select: text;
      -webkit-user-select: text;
    }
    .nick {
      color: var(--color-accent);
      font-weight: 600;
      user-select: text;
      -webkit-user-select: text;
    }
    .composer {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    .composer input {
      flex: 1;
    }
    .status {
      font-size: var(--font-size-xs);
      color: var(--color-text-muted);
    }
    .conn-status {
      margin-left: 4px;
      font-size: var(--font-size-xs);
      color: var(--color-text-muted);
      min-width: 9rem;
      white-space: nowrap;
    }
    .conn-status.busy {
      color: var(--color-accent-muted, var(--color-accent));
    }
    .conn-status.ok {
      color: #6fbf73;
      font-weight: 600;
    }
    .conn-status.bad {
      color: var(--color-dangerous);
      font-weight: 600;
    }
    .err {
      color: var(--color-dangerous);
      font-size: var(--font-size-sm);
    }
    .dm {
      margin-top: 8px;
      padding: 10px;
      background: var(--color-charcoal-raised);
      border-radius: var(--border-radius-md);
      font-size: var(--font-size-xs);
    }
    .dm code {
      word-break: break-all;
      color: var(--color-accent-muted);
    }
    .toast {
      position: fixed;
      bottom: 60px;
      right: 20px;
      background: var(--color-accent);
      color: var(--color-on-accent);
      padding: 8px 14px;
      border-radius: var(--border-radius-md);
      font-size: var(--font-size-xs);
      font-weight: 600;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      z-index: 1000;
    }
  `;

  async connectedCallback() {
    super.connectedCallback();
    this.status = await api.chatStatus();
    if (
      this.status !== "stopped" &&
      this.status !== "not_running" &&
      this.status !== "failed"
    ) {
      this.startStatusPoll();
    }
    try {
      this.dmKeys = await api.dmLoadKeypair();
    } catch {
      this.dmKeys = null;
    }
    // Drop any legacy webview-local secret.
    try {
      localStorage.removeItem("nighthawk.dm.keypair");
    } catch {
      /* ignore */
    }
    this.unlisten = await api.onChatMessage(async (m) => {
      if (
        m.channel === this.channel ||
        m.channel.replace(/^#/, "") === this.channel.replace(/^#/, "")
      ) {
        let display = m;
        if (this.dmMode && this.dmKeys && this.peerPublic) {
          try {
            const plain = await api.dmDecrypt({
              mySecretB58: this.dmKeys.secretB58,
              theirPublicB58: this.peerPublic,
              ciphertextB58: m.message,
            });
            display = { ...m, message: plain };
            this.decryptedHint = "DM decrypted";
          } catch {
            /* leave ciphertext */
          }
        }
        this.messages = [...this.messages, display].slice(-200);
        this.scrollToBottom();
      }
    });
  }

  private scrollToBottom() {
    requestAnimationFrame(() => {
      const el = this.shadowRoot?.querySelector(".msgs");
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  updated() {
    // Scroll to bottom after every render so chat always shows newest messages.
    this.scrollToBottom();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unlisten?.();
    this.stopStatusPoll();
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    if (this.touchTimer) window.clearTimeout(this.touchTimer);
  }

  private copyMessage(text: string) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
    }
    this.showToast("Message copied to clipboard");
  }

  private showToast(msg: string) {
    this.toastMessage = msg;
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastMessage = "";
    }, 2000);
  }

  private handleTouchStart(text: string) {
    this.touchTimer = window.setTimeout(() => {
      this.copyMessage(text);
    }, 500);
  }

  private handleTouchEnd() {
    if (this.touchTimer) {
      window.clearTimeout(this.touchTimer);
      this.touchTimer = undefined;
    }
  }

  private async genDmKeys() {
    try {
      this.dmKeys = await api.dmGenerateKeypair();
      this.error = "";
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private async start() {
    this.error = "";
    this.status = "starting";
    this.startStatusPoll();
    try {
      await api.chatStart();
      this.status = await api.chatStatus();
      if (!this.isTerminalPhase(this.status) || this.status === "connected") {
        this.startStatusPoll();
      }
    } catch (e: any) {
      this.error = String(e);
      this.status = await api.chatStatus().catch(() => "failed");
      this.stopStatusPoll();
    }
  }

  private async stop() {
    this.status = "stopping";
    this.startStatusPoll();
    try {
      await api.chatStop();
    } finally {
      this.status = await api.chatStatus().catch(() => "stopped");
      if (this.status === "stopped" || this.status === "not_running") {
        this.stopStatusPoll();
      }
    }
  }

  private async send() {
    if (!this.draft.trim()) return;
    const text = this.draft.trim();
    this.draft = "";

    if (text.startsWith("/")) {
      const parts = text.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = text.substring(parts[0].length).trim();

      switch (cmd) {
        case "/nick": {
          if (arg && arg.length <= 24) {
            try {
              await api.setChatNick(arg);
              this.messages = [
                ...this.messages,
                { eventId: `sys-${Date.now()}`, channel: this.channel, nick: "System", message: `Your nickname is now: ${arg}`, timestamp: Date.now() },
              ];
            } catch (e: any) {
              this.error = String(e);
            }
          } else {
            this.messages = [
              ...this.messages,
              { eventId: `sys-${Date.now()}`, channel: this.channel, nick: "System", message: "Invalid nickname. Usage: /nick <name> (1–24 alphanumeric/underscore characters)", timestamp: Date.now() },
            ];
          }
          return;
        }
        case "/join": {
          if (arg) {
            const targetChan = arg.startsWith("#") ? arg : `#${arg}`;
            if (!this.channelsList.includes(targetChan)) {
              this.channelsList = [...this.channelsList, targetChan];
            }
            this.channel = targetChan;
            this.messages = [
              ...this.messages,
              { eventId: `sys-${Date.now()}`, channel: targetChan, nick: "System", message: `Joined channel: ${targetChan}`, timestamp: Date.now() },
            ];
          } else {
            this.messages = [
              ...this.messages,
              { eventId: `sys-${Date.now()}`, channel: this.channel, nick: "System", message: "Usage: /join <#channel>", timestamp: Date.now() },
            ];
          }
          return;
        }
        case "/part":
        case "/leave": {
          this.channelsList = this.channelsList.filter((c) => c !== this.channel);
          if (this.channelsList.length > 0) {
            this.channel = this.channelsList[0];
          }
          this.messages = [];
          return;
        }
        case "/clear": {
          this.messages = [];
          return;
        }
        case "/me": {
          if (arg) {
            try {
              const nick = await api.getChatNick();
              const actionText = `* ${nick} ${arg}`;
              // Send the pre-formatted action text (no /me prefix) so the
              // backend doesn't double-parse it as a slash command.
              await api.chatSend(this.channel, actionText);
            } catch (e: any) {
              this.error = String(e);
            }
          } else {
            this.messages = [
              ...this.messages,
              { eventId: `sys-${Date.now()}`, channel: this.channel, nick: "System", message: "Usage: /me <action>", timestamp: Date.now() },
            ];
          }
          return;
        }
        case "/msg": {
          const msgParts = arg.split(/\s+/);
          if (msgParts.length >= 2) {
            const target = msgParts[0];
            let msgContent = arg.substring(target.length).trim();
            try {
              // Send directly to target — the content is a plain message,
              // not a command. Prefix handling is already done above.
              await api.chatSend(target, msgContent);
              this.messages = [
                ...this.messages,
                { eventId: `sys-${Date.now()}`, channel: this.channel, nick: "System", message: `Sent message to ${target}: ${msgContent}`, timestamp: Date.now() },
              ];
            } catch (e: any) {
              this.error = String(e);
            }
          } else {
            this.messages = [
              ...this.messages,
              { eventId: `sys-${Date.now()}`, channel: this.channel, nick: "System", message: "Usage: /msg <target> <message>", timestamp: Date.now() },
            ];
          }
          return;
        }
        case "/help": {
          const helpText = `Available DarkIRC commands:
  /nick <name> — Change nickname (1–24 characters)
  /join <#channel> — Join or switch to channel
  /part — Leave current channel
  /clear — Clear messages in current view
  /me <action> — Send action message (* nick action)
  /msg <target> <text> — Send message to target
  /help — Show this help message`;
          this.messages = [
            ...this.messages,
            { eventId: `sys-${Date.now()}`, channel: this.channel, nick: "System", message: helpText, timestamp: Date.now() },
          ];
          return;
        }
        default: {
          this.messages = [
            ...this.messages,
            { eventId: `sys-${Date.now()}`, channel: this.channel, nick: "System", message: `Unknown command '${cmd}'. Type /help for DarkIRC commands.`, timestamp: Date.now() },
          ];
          return;
        }
      }
    }

    try {
      let body = text;
      if (this.dmMode) {
        if (!this.dmKeys || !this.peerPublic.trim()) {
          this.error = "Generate DM keys and set peer public key first";
          return;
        }
        body = await api.dmEncrypt({
          mySecretB58: this.dmKeys.secretB58,
          theirPublicB58: this.peerPublic.trim(),
          plaintext: body,
        });
      }
      await api.chatSend(this.channel, body);
    } catch (e: any) {
      this.error = String(e);
    }
  }

  render() {
    return html`
      <div class="top">
        <select
          .value=${this.channel}
          @change=${(e: Event) => {
            this.channel = (e.target as HTMLSelectElement).value;
            this.messages = [];
          }}
        >
          ${this.channelsList.map((c) => html`<option value=${c}>${c}</option>`)}
        </select>
        <button class="primary" @click=${this.start}>Connect</button>
        <button @click=${this.stop}>Stop</button>
        <span
          class="conn-status ${ChatScreen.phaseClass(this.status)}"
          title=${this.status}
        >
          ${ChatScreen.phaseLabel(this.status)}
        </span>
        <label>
          <input
            type="checkbox"
            .checked=${this.dmMode}
            @change=${(e: Event) =>
              (this.dmMode = (e.target as HTMLInputElement).checked)}
          />
          E2E DM
        </label>
      </div>
      ${this.dmMode
        ? html`
            <div class="dm">
              <button class="primary" @click=${this.genDmKeys}>
                ${this.dmKeys ? "Rotate DM keys" : "Generate DM keys"}
              </button>
              ${this.dmKeys
                ? html`<p>
                    Your public key:<br /><code>${this.dmKeys.publicB58}</code>
                  </p>`
                : null}
              <input
                style="width:100%;margin-top:8px;box-sizing:border-box"
                placeholder="Peer public key (base58)"
                .value=${this.peerPublic}
                @input=${(e: Event) =>
                  (this.peerPublic = (e.target as HTMLInputElement).value)}
              />
              ${this.decryptedHint
                ? html`<p class="status">${this.decryptedHint}</p>`
                : null}
            </div>
          `
        : null}
      <div class="msgs">
        ${this.messages.map(
          (m) => html`
            <div
              class="m"
              title="Click, long press, or right-click to copy"
              @contextmenu=${(e: MouseEvent) => {
                e.preventDefault();
                this.copyMessage(m.message);
              }}
              @touchstart=${() => this.handleTouchStart(m.message)}
              @touchend=${() => this.handleTouchEnd()}
              @touchcancel=${() => this.handleTouchEnd()}
            >
              <span class="nick">${m.nick}</span>: <span class="content">${m.message}</span>
            </div>
          `,
        )}
      </div>
      ${this.toastMessage ? html`<div class="toast">${this.toastMessage}</div>` : null}
      <div class="composer">
        <input
          placeholder=${this.dmMode ? "Encrypted message…" : "Message…"}
          .value=${this.draft}
          @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.send()}
          @input=${(e: Event) =>
            (this.draft = (e.target as HTMLInputElement).value)}
        />
        <button class="primary" @click=${this.send}>Send</button>
      </div>
      ${this.error ? html`<p class="err">${this.error}</p>` : null}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-screen": ChatScreen;
  }
}
