import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { api, type ChatMessage, type DmKeypair } from "../lib/api";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  clearDmUnread,
  loadDmContacts,
  removeDmContact,
  saveDmContacts,
  upsertDmContact,
  type DmContact,
} from "../lib/dm-contacts";

/** Match mobile DarkfiChatDefaults.DEFAULT_PUBLIC_CHANNELS. */
const CHANNELS = [
  "#dev",
  "#media",
  "#hackers",
  "#memes",
  "#philosophy",
  "#markets",
  "#math",
  "#random",
  "#lunardao",
];

/** Canonical channel key: leading `#`, lowercased (IRC channels are case-insensitive). */
function chanKey(channel: string): string {
  const t = channel.trim();
  const withHash = t.startsWith("#") ? t : `#${t}`;
  return withHash.toLowerCase();
}

function sameChannel(a: string, b: string): boolean {
  return chanKey(a) === chanKey(b);
}

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
  @state() private nick = "";
  @state() private dmContacts: DmContact[] = [];
  @state() private dmContactLabel = "";
  @state() private autoReconnect = true;
  /** Per-channel history (oldest → newest), like mobile channelMessages. */
  private channelMessages: Record<string, ChatMessage[]> = {};
  /** Per-channel unread counts, like mobile Channel.unreadCount. */
  @state() private unreadCounts: Record<string, number> = {};
  private seenEventIds = new Set<string>();
  private unlisten?: UnlistenFn;
  private toastTimer?: number;
  private touchTimer?: number;
  private statusPoll?: number;
  private prevMessageCount = 0;
  private reconnectTimer?: number;
  private wasConnected = false;
  private reconnectAttempts = 0;

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
        const prev = this.status;
        const next = await api.chatStatus();
        this.status = next;
        if (next === "connected" || next === "running") {
          this.wasConnected = true;
          this.reconnectAttempts = 0;
        }
        // After a successful session, daemon death → schedule reconnect.
        // (Do not treat waiting_for_peers as fatal — that is normal DAG sync.)
        if (
          this.autoReconnect &&
          this.wasConnected &&
          (next === "failed" || next === "not_running" || next === "stopped")
        ) {
          this.scheduleReconnect();
        }
        if (next === "stopped" || next === "not_running") {
          this.stopStatusPoll();
        }
      } catch {
        /* ignore transient poll errors */
      }
    }, 500);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= 5) {
      this.pushSystem("Auto-reconnect gave up after 5 attempts — tap Retry.");
      return;
    }
    const delay = Math.min(15_000, 2000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.pushSystem(
      `Connection lost — retrying in ${Math.round(delay / 1000)}s…`,
    );
    this.reconnectTimer = window.setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await api.chatStop().catch(() => undefined);
        await this.start();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      padding: 12px 16px;
      box-sizing: border-box;
      min-height: 0;
    }
    .top {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 10px;
      flex-wrap: wrap;
      flex-shrink: 0;
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
      min-height: 0;
      overflow-y: auto;
      background: var(--color-ink-panel);
      border-radius: var(--border-radius-md);
      padding: 8px 10px;
      font-size: var(--font-size-sm);
      line-height: 1.4;
      text-align: left;
      user-select: text;
      -webkit-user-select: text;
      display: flex;
      flex-direction: column;
      align-items: stretch;
    }
    /* Pin the thread to the bottom of the pane (mobile-style). */
    .msgs-inner {
      margin-top: auto;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
      width: 100%;
    }
    .m {
      display: grid;
      grid-template-columns: minmax(4.5rem, max-content) 1fr;
      column-gap: 8px;
      row-gap: 0;
      margin: 0;
      padding: 1px 4px;
      border-radius: 4px;
      text-align: left;
      user-select: text;
      -webkit-user-select: text;
      cursor: pointer;
      transition: background 0.15s ease;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .m:hover {
      background: rgba(255, 255, 255, 0.05);
    }
    .m.system .nick {
      color: var(--color-text-muted);
    }
    .m .content {
      text-align: left;
      min-width: 0;
      user-select: text;
      -webkit-user-select: text;
      color: var(--color-text-body);
    }
    .nick {
      color: var(--color-accent);
      font-weight: 600;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      user-select: text;
      -webkit-user-select: text;
    }
    .composer {
      display: flex;
      gap: 8px;
      margin-top: 10px;
      flex-shrink: 0;
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
      flex-shrink: 0;
    }
    .dm {
      margin-top: 8px;
      margin-bottom: 8px;
      padding: 10px;
      background: var(--color-charcoal-raised);
      border-radius: var(--border-radius-md);
      font-size: var(--font-size-xs);
      flex-shrink: 0;
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
    .nick-chip {
      font-size: var(--font-size-xs);
      color: var(--color-text-muted);
      margin-left: auto;
    }
    .contacts {
      margin-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .contact {
      display: flex;
      gap: 8px;
      align-items: center;
      font-size: var(--font-size-xs);
    }
    .contact button {
      padding: 4px 8px;
      font-size: var(--font-size-xs);
    }
    .badge {
      background: var(--color-accent);
      color: var(--color-on-accent);
      border-radius: 999px;
      padding: 0 6px;
      font-weight: 700;
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
      this.nick = await api.getChatNick();
    } catch {
      this.nick = "";
    }
    try {
      this.dmKeys = await api.dmLoadKeypair();
    } catch {
      this.dmKeys = null;
    }
    this.dmContacts = loadDmContacts();
    try {
      localStorage.removeItem("nighthawk.dm.keypair");
    } catch {
      /* ignore */
    }
    this.unlisten = await api.onChatMessage(async (m) => {
      await this.ingestMessage(m);
    });
    this.loadChannel(this.channel);
  }

  private async ingestMessage(m: ChatMessage) {
    if (this.seenEventIds.has(m.eventId)) return;
    this.seenEventIds.add(m.eventId);

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

    const key = chanKey(m.channel);
    const prior = this.channelMessages[key] ?? [];
    this.channelMessages[key] = [...prior, display].slice(-500);

    if (sameChannel(m.channel, this.channel)) {
      this.messages = this.channelMessages[key];
    } else {
      // Increment unread for non-active channels (matches mobile unreadCount).
      this.unreadCounts = {
        ...this.unreadCounts,
        [key]: (this.unreadCounts[key] ?? 0) + 1,
      };
      if (!this.channelsList.some((c) => sameChannel(c, key))) {
        // Auto-add unknown channels that receive traffic (e.g. /msg targets).
        this.channelsList = [...this.channelsList, key];
      }
    }
  }

  private persistActiveChannel() {
    this.channelMessages[chanKey(this.channel)] = this.messages;
  }

  private loadChannel(channel: string) {
    const key = chanKey(channel);
    this.channel = key;
    this.messages = [...(this.channelMessages[key] ?? [])];
    this.prevMessageCount = -1; // force scroll after switch
    // Clear unread for the channel we're switching to.
    if ((this.unreadCounts[key] ?? 0) > 0) {
      this.unreadCounts = { ...this.unreadCounts, [key]: 0 };
    }
  }

  /** Failed → Retry; stopped / not running → Connect (one button, like mobile). */
  private get connectLabel(): string {
    return this.status === "failed" ? "Retry" : "Connect";
  }

  private switchChannel(channel: string) {
    if (sameChannel(channel, this.channel)) return;
    this.persistActiveChannel();
    this.loadChannel(channel);
  }

  private pushSystem(message: string, channel = this.channel) {
    const m: ChatMessage = {
      eventId: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channel,
      nick: "System",
      message,
      timestamp: Date.now(),
    };
    const key = chanKey(channel);
    const prior = this.channelMessages[key] ?? [];
    this.channelMessages[key] = [...prior, m].slice(-500);
    if (sameChannel(channel, this.channel)) {
      this.messages = this.channelMessages[key];
    }
  }

  private scrollToBottom() {
    requestAnimationFrame(() => {
      const el = this.shadowRoot?.querySelector(".msgs") as HTMLElement | null;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  updated() {
    // Only auto-scroll when the message list grows (not on every keystroke).
    if (this.messages.length !== this.prevMessageCount) {
      this.prevMessageCount = this.messages.length;
      this.scrollToBottom();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unlisten?.();
    this.stopStatusPoll();
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
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

  /**
   * `chat_status` returns DAG phase (`stopped` / `connected` / …), not the
   * coarse lifecycle string Android/iOS poll with `darkircStatus()`.
   */
  private isIdlePhase(phase: string) {
    return (
      phase === "not_running" ||
      phase === "stopped" ||
      phase === "failed"
    );
  }

  /** Wait until FFI reports idle so the next start is not rejected as "stopping". */
  private async awaitDaemonNotRunning(timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await api.chatStatus().catch(() => "");
      if (this.isIdlePhase(s)) {
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  private async start() {
    this.error = "";
    // Stop any live/failed session (phase may be `connected` or a DAG-sync
    // name, not `running`), then drain like iOS `restartForChat`.
    const cur = await api.chatStatus().catch(() => this.status);
    if (cur === "failed" || !this.isIdlePhase(cur)) {
      await api.chatStop().catch(() => undefined);
    }
    await this.awaitDaemonNotRunning();
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
      if (this.autoReconnect && this.wasConnected) {
        this.scheduleReconnect();
      } else {
        this.stopStatusPoll();
      }
    }
  }

  private saveContact() {
    if (!this.peerPublic.trim()) {
      this.error = "Enter peer public key first";
      return;
    }
    this.dmContacts = upsertDmContact(this.dmContacts, {
      label: this.dmContactLabel,
      publicB58: this.peerPublic.trim(),
    });
    saveDmContacts(this.dmContacts);
    this.dmContactLabel = "";
    this.showToast("DM contact saved");
  }

  private selectContact(c: DmContact) {
    this.peerPublic = c.publicB58;
    this.dmContacts = clearDmUnread(this.dmContacts, c.publicB58);
    saveDmContacts(this.dmContacts);
    this.dmMode = true;
  }

  private deleteContact(id: string) {
    this.dmContacts = removeDmContact(this.dmContacts, id);
    saveDmContacts(this.dmContacts);
  }

  private async stop() {
    this.wasConnected = false;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
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
    this.error = "";

    if (text.startsWith("/")) {
      const parts = text.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = text.substring(parts[0].length).trim();

      switch (cmd) {
        case "/nick": {
          if (!arg) {
            this.pushSystem(
              "Usage: /nick <name> (1–24 alphanumeric/underscore characters)",
            );
            return;
          }
          try {
            await api.setChatNick(arg);
            this.nick = await api.getChatNick();
            this.pushSystem(`Your nickname is now: ${this.nick}`);
          } catch (e: any) {
            this.error = String(e);
            this.pushSystem(String(e));
          }
          return;
        }
        case "/join": {
          if (!arg) {
            this.pushSystem("Usage: /join <#channel>");
            return;
          }
          const targetChan = chanKey(arg);
          if (!this.channelsList.some((c) => sameChannel(c, targetChan))) {
            this.channelsList = [...this.channelsList, targetChan];
          }
          this.switchChannel(targetChan);
          this.pushSystem(`Joined channel: ${targetChan}`, targetChan);
          return;
        }
        case "/part":
        case "/leave": {
          const leaving = this.channel;
          this.persistActiveChannel();
          delete this.channelMessages[chanKey(leaving)];
          this.channelsList = this.channelsList.filter(
            (c) => !sameChannel(c, leaving),
          );
          if (this.channelsList.length === 0) {
            this.channelsList = ["#dev"];
          }
          this.loadChannel(this.channelsList[0]);
          this.pushSystem(`Left channel: ${leaving}`);
          return;
        }
        case "/clear": {
          const key = chanKey(this.channel);
          this.channelMessages[key] = [];
          this.messages = [];
          return;
        }
        case "/me": {
          if (!arg) {
            this.pushSystem("Usage: /me <action>");
            return;
          }
          try {
            const nick = this.nick || (await api.getChatNick());
            const actionText = `* ${nick} ${arg}`;
            this.pushOptimistic(nick, actionText);
            await api.chatSend(this.channel, actionText);
          } catch (e: any) {
            this.error = String(e);
          }
          return;
        }
        case "/msg": {
          const msgParts = arg.split(/\s+/);
          if (msgParts.length < 2) {
            this.pushSystem("Usage: /msg <target> <message>");
            return;
          }
          const target = msgParts[0];
          const msgContent = arg.substring(target.length).trim();
          try {
            await api.chatSend(target, msgContent);
            this.pushSystem(`→ ${target}: ${msgContent}`);
          } catch (e: any) {
            this.error = String(e);
          }
          return;
        }
        case "/whoami": {
          try {
            this.nick = await api.getChatNick();
            this.pushSystem(`You are ${this.nick || "(unnamed)"} on ${this.channel}`);
          } catch (e: any) {
            this.error = String(e);
          }
          return;
        }
        case "/channels":
        case "/list": {
          this.pushSystem(
            `Channels: ${this.channelsList.join(", ")}\nActive: ${this.channel}`,
          );
          return;
        }
        case "/help": {
          this.pushSystem(`Available DarkIRC commands:
  /nick <name> — Change nickname (1–24 alphanumeric/underscore)
  /whoami — Show your current nickname
  /join <#channel> — Join or switch to channel
  /part | /leave — Leave current channel
  /channels | /list — List joined channels
  /clear — Clear messages in current channel view
  /me <action> — Send action message (* nick action)
  /msg <target> <text> — Send message to nick or #channel
  /help — Show this help message`);
          return;
        }
        default: {
          this.pushSystem(
            `Unknown command '${cmd}'. Type /help for DarkIRC commands.`,
          );
          return;
        }
      }
    }

    try {
      let body = text;
      let displayBody = text;
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
      const nick = this.nick || (await api.getChatNick()) || "me";
      this.pushOptimistic(nick, displayBody);
      await api.chatSend(this.channel, body);
    } catch (e: any) {
      this.error = String(e);
    }
  }

  private pushOptimistic(nick: string, message: string) {
    const m: ChatMessage = {
      eventId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channel: this.channel,
      nick,
      message,
      timestamp: Date.now(),
    };
    // Don't add to seenEventIds — network echo uses a different event id.
    const key = chanKey(this.channel);
    const prior = this.channelMessages[key] ?? [];
    this.channelMessages[key] = [...prior, m].slice(-500);
    this.messages = this.channelMessages[key];
  }

  render() {
    return html`
      <div class="top">
        <select
          .value=${this.channel}
          @change=${(e: Event) => {
            this.switchChannel((e.target as HTMLSelectElement).value);
          }}
        >
          ${this.channelsList.map((c) => {
            const badge = this.unreadCounts[chanKey(c)] ?? 0;
            return html`<option value=${c}>${c}${badge > 0 ? ` (${badge})` : ""}</option>`;
          })}
        </select>
        <button class="primary" @click=${this.start}>${this.connectLabel}</button>
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
        ${this.nick
          ? html`<span class="nick-chip" title="Current nick">@${this.nick}</span>`
          : null}
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
              <div class="contact" style="margin-top:8px">
                <input
                  style="flex:1"
                  placeholder="Contact label"
                  .value=${this.dmContactLabel}
                  @input=${(e: Event) =>
                    (this.dmContactLabel = (
                      e.target as HTMLInputElement
                    ).value)}
                />
                <button class="primary" @click=${this.saveContact}>
                  Save contact
                </button>
              </div>
              ${this.dmContacts.length
                ? html`
                    <div class="contacts">
                      ${this.dmContacts.map(
                        (c) => html`
                          <div class="contact">
                            <button
                              class="primary"
                              @click=${() => this.selectContact(c)}
                            >
                              ${c.label}
                              ${c.unread > 0
                                ? html`<span class="badge">${c.unread}</span>`
                                : null}
                            </button>
                            <code title=${c.publicB58}
                              >${c.publicB58.slice(0, 10)}…</code
                            >
                            <button @click=${() => this.deleteContact(c.id)}>
                              Remove
                            </button>
                          </div>
                        `,
                      )}
                    </div>
                  `
                : html`<p class="status">No DM contacts yet</p>`}
              ${this.decryptedHint
                ? html`<p class="status">${this.decryptedHint}</p>`
                : null}
            </div>
          `
        : null}
      <div class="msgs">
        <div class="msgs-inner">
          ${this.messages.map(
            (m) => html`
              <div
                class="m ${m.nick === "System" ? "system" : ""}"
                title="Click, long press, or right-click to copy"
                @contextmenu=${(e: MouseEvent) => {
                  e.preventDefault();
                  this.copyMessage(m.message);
                }}
                @touchstart=${() => this.handleTouchStart(m.message)}
                @touchend=${() => this.handleTouchEnd()}
                @touchcancel=${() => this.handleTouchEnd()}
              >
                <span class="nick">&lt;${m.nick}&gt;</span>
                <span class="content">${m.message}</span>
              </div>
            `,
          )}
        </div>
      </div>
      ${this.toastMessage
        ? html`<div class="toast">${this.toastMessage}</div>`
        : null}
      <div class="composer">
        <input
          placeholder=${this.dmMode
            ? "Encrypted message…"
            : "Message or /command…"}
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
