import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, formatInvokeError, type ChatMessage, type DmKeypair } from "../lib/api";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { isValidDrkAmount } from "../lib/amount";
import {
  bumpDmUnread,
  clearDmUnread,
  clearLegacyDmStorage,
  readLegacyDmContacts,
  type DmContact,
} from "../lib/dm-contacts";
import {
  decideFud,
  fudOffersEnabled,
  hasFud,
  isOwnNick,
  lexChat,
  threadIsEncrypted,
  parseFud,
  peerNickIndex,
  queueFud,
} from "../lib/chat-chrome";
import {
  DEFAULT_PUBLIC_CHANNELS,
  DEFAULT_SELECTED_CHANNEL,
} from "../lib/chat-defaults";
import {
  CHAT_RECEIPT_EVENT,
  findInvoice,
  isClearnetHttp,
  parseReceipt,
  stageChatPayContext,
  type ChatReceiptDetail,
} from "../lib/chat-wallet";
import {
  buildPaymentUri,
  MAX_PAYMENT_MEMO_BYTES,
  truncateUtf8Bytes,
  utf8ByteLength,
} from "../lib/payment-uri";

const CHANNELS: string[] = [...DEFAULT_PUBLIC_CHANNELS];

/** Canonical thread key: lowercased `#channel` for public rooms, exact-case nick for DMs. */
function chanKey(channel: string): string {
  const t = channel.trim();
  return t.startsWith("#") ? t.toLowerCase() : t;
}

function sameChannel(a: string, b: string): boolean {
  return chanKey(a) === chanKey(b);
}

@customElement("chat-screen")
export class ChatScreen extends LitElement {
  @state() private channel: string = DEFAULT_SELECTED_CHANNEL;
  @state() private channelsList: string[] = [...CHANNELS];
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
  @state() private showRequestModal = false;
  @state() private requestAmount = "";
  @state() private requestMemo = "";
  @state() private requestError = "";
  /** Per-channel history (oldest → newest), like mobile channelMessages. */
  private channelMessages: Record<string, ChatMessage[]> = {};
  /** Per-channel unread counts, like mobile Channel.unreadCount. */
  @state() private unreadCounts: Record<string, number> = {};
  private static readonly MAX_SEEN_EVENT_IDS = 5000;
  private seenEventIds = new Set<string>();
  private unlisten?: UnlistenFn;
  private toastTimer?: number;
  private touchTimer?: number;
  private statusPoll?: number;
  private prevMessageCount = 0;
  private reconnectTimer?: number;
  private wasConnected = false;
  private reconnectAttempts = 0;
  /** Messages held until DarkIRC reports connected, matching the mobile outbox. */
  private outbox: Array<{ channel: string; wire: string }> = [];
  private onChatReceipt = (e: Event) => {
    const detail = (e as CustomEvent<ChatReceiptDetail>).detail;
    if (detail) void this.postPaymentReceipt(detail);
  };

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

  private chatReady(): boolean {
    return this.status === "connected" || this.status === "running";
  }

  /** Send now, or keep the wire text until DarkIRC is connected. */
  private async deliverChat(channel: string, wire: string) {
    if (!this.chatReady()) {
      this.outbox.push({ channel, wire });
      this.error = "Queued until DarkIRC connects";
      return;
    }
    await api.chatSend(channel, wire);
  }

  private flushingOutbox = false;

  private async flushOutbox() {
    if (this.flushingOutbox || !this.chatReady() || this.outbox.length === 0) return;
    this.flushingOutbox = true;
    try {
      while (this.chatReady() && this.outbox.length > 0) {
        const item = this.outbox[0];
        try {
          await api.chatSend(item.channel, item.wire);
          this.outbox.shift();
        } catch {
          return;
        }
      }
      if (this.error === "Queued until DarkIRC connects") this.error = "";
    } finally {
      this.flushingOutbox = false;
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
          void this.flushOutbox();
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
      font-family: var(--font-family-base);
      font-size: var(--font-size-sm);
      line-height: 1.45;
    }
    :host([hidden]) {
      display: none;
    }
    .top {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 10px;
      flex-wrap: wrap;
      flex-shrink: 0;
    }
    .chrome-actions {
      display: flex;
      align-items: center;
      margin-left: auto;
      gap: 0;
    }
    .chrome-actions button.icon {
      width: 40px;
      height: 40px;
      padding: 0;
      margin: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid transparent;
      color: var(--color-chat-selection-bright, var(--color-text-header));
      cursor: pointer;
      font-size: 1.15rem;
      line-height: 1;
      border-radius: var(--border-radius-md);
    }
    .chrome-actions button.icon:hover {
      background: var(--color-elevated);
      border-color: var(--color-steel-border);
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
    select {
      border-color: var(--color-chat-selection-bright, var(--color-steel-border));
      background: var(--color-chat-selection, var(--color-elevated));
      color: var(--color-chat-selection-on, var(--color-text-header));
    }
    select:focus {
      outline: 2px solid var(--color-chat-selection-bright, var(--color-accent));
      outline-offset: 1px;
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
      line-height: 1.5;
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
    .m.mine .content {
      color: var(--color-text-header);
    }
    .m.peer .content {
      color: var(--color-text-body);
    }
    .m.encrypted {
      padding: 6px 8px;
      margin: 2px 0;
    }
    .m.encrypted.mine {
      background: var(--color-accent-subtle-container);
    }
    .m.encrypted.peer {
      background: var(--color-charcoal-raised);
    }
    .m.encrypted:hover {
      background: var(--color-elevated);
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
    .m .fud-hint {
      grid-column: 2;
      font-size: var(--font-size-xs);
      color: var(--color-text-muted);
    }
    .m .pay-card {
      grid-column: 2;
      margin-top: 6px;
      padding: 10px 12px;
      border-radius: var(--border-radius-md);
      border: 1px solid var(--color-steel-border);
      background: var(--color-charcoal-raised);
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-width: 360px;
    }
    .m .pay-card .pay-title {
      font-weight: 600;
      color: var(--color-text-header);
    }
    .m .pay-card .pay-tx {
      font-family: var(--font-family-mono);
      font-size: var(--font-size-xs);
      color: var(--color-text-muted);
      word-break: break-all;
    }
    .m .pay-card button {
      align-self: flex-start;
      padding: 6px 14px;
      font-size: var(--font-size-xs);
    }
    .req-modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 120;
      padding: 16px;
    }
    .req-modal {
      background: var(--color-charcoal-raised);
      border: 1px solid var(--color-steel-border);
      border-radius: var(--border-radius-lg);
      padding: 20px;
      max-width: 420px;
      width: 100%;
      box-sizing: border-box;
    }
    .req-modal h3 {
      margin: 0 0 12px;
      color: var(--color-text-header);
    }
    .req-modal label {
      display: block;
      margin-top: 10px;
      font-size: var(--font-size-xs);
      color: var(--color-text-muted);
    }
    .req-modal input {
      width: 100%;
      box-sizing: border-box;
      margin-top: 4px;
    }
    .req-modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    }
    .nick {
      font-weight: 600;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      user-select: text;
      -webkit-user-select: text;
    }
    .nick.own {
      color: var(--color-accent);
    }
    .nick.h0 { color: #7DADB9; }
    .nick.h1 { color: #7AA3F3; }
    .nick.h2 { color: #9BBDCF; }
    .nick.h3 { color: #9DEA79; }
    .nick.h4 { color: #A8B2BD; }
    .nick.h5 { color: #9C5776; }
    .nick.h6 { color: #4F8799; }
    .nick.h7 { color: #C5CED6; }
    a.chat-link {
      color: var(--color-accent-muted);
      text-decoration: underline;
    }
    .chat-fud {
      color: var(--color-text-muted);
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
      background: var(--color-chat-selection-bright, var(--color-accent));
      color: var(--color-chat-selection-on, var(--color-on-accent));
      border-radius: 999px;
      padding: 0 6px;
      font-weight: 700;
    }
    .contact.selected,
    .contact:has(button:focus) {
      background: var(--color-chat-selection, rgba(107, 26, 107, 0.45));
      border-radius: var(--border-radius-md);
      padding: 4px 6px;
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
    try {
      const legacy = readLegacyDmContacts();
      this.dmContacts =
        legacy.length > 0
          ? await api.dmContactsMigrate(legacy)
          : await api.dmContactsList();
      clearLegacyDmStorage();
    } catch {
      this.dmContacts = [];
    }
    window.addEventListener(CHAT_RECEIPT_EVENT, this.onChatReceipt);
    this.unlisten = await api.onChatMessage(async (m) => {
      await this.ingestMessage(m);
    });
    this.loadChannel(this.channel);
  }

  private async ingestMessage(m: ChatMessage) {
    if (this.seenEventIds.has(m.eventId)) return;
    this.seenEventIds.add(m.eventId);
    if (this.seenEventIds.size > ChatScreen.MAX_SEEN_EVENT_IDS) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest !== undefined) this.seenEventIds.delete(oldest);
    }

    // The daemon already saltbox-decrypts nick DMs before this event.
    // Decrypting again would show the inner ciphertext.
    const display = m;
    const key = chanKey(m.channel);
    let prior = this.channelMessages[key] ?? [];
    if (m.isOutgoing || isOwnNick(m.nick, this.nick)) {
      const optIdx = prior.findIndex(
        (item) => item.eventId.startsWith("local-") && item.message === display.message,
      );
      if (optIdx !== -1) {
        prior = [...prior.slice(0, optIdx), ...prior.slice(optIdx + 1)];
      }
    }
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
      const matchedContact = this.dmContacts.find(
        (c) =>
          c.label.trim().toLowerCase() === key.toLowerCase() ||
          c.label.trim().toLowerCase() === m.nick.trim().toLowerCase(),
      );
      if (matchedContact && !m.isOutgoing) {
        this.dmContacts = bumpDmUnread(this.dmContacts, matchedContact.publicB58);
        void api
          .dmContactsBumpUnread(matchedContact.publicB58)
          .then((list) => {
            this.dmContacts = list;
          })
          .catch(() => undefined);
      }
    }
  }

  private persistActiveChannel() {
    this.channelMessages[chanKey(this.channel)] = this.messages;
  }

  private loadChannel(channel: string) {
    const key = chanKey(channel);
    this.channel = key;
    if (key.startsWith("#")) {
      this.dmMode = false;
    }
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
      isOutgoing: false,
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
    window.removeEventListener(CHAT_RECEIPT_EVENT, this.onChatReceipt);
    this.unlisten?.();
    this.stopStatusPoll();
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    if (this.touchTimer) window.clearTimeout(this.touchTimer);
  }

  private async queueOffer(text: string) {
    const spanned = lexChat(text).find((span) => span.kind === "fud");
    const uri =
      (spanned?.kind === "fud" ? parseFud(spanned.value) : null) ?? parseFud(text);
    let privateTransport = false;
    try {
      const prefs = await api.getPrefs();
      privateTransport = Boolean(prefs.useTor || prefs.useNym);
    } catch {
      privateTransport = false;
    }
    switch (decideFud(fudOffersEnabled(), privateTransport, uri)) {
      case "allowed":
        if (uri) {
          queueFud(uri);
          this.showToast(`Queued ${uri.fileName ?? uri.infoHash}. The file is not downloaded.`);
        }
        break;
      case "disabled":
        this.showToast("File offers are off. Turn them on in Settings.");
        break;
      case "needsPrivateTransport":
        this.showToast("File offers need Tor. Clearnet is rejected.");
        break;
      case "invalid":
        this.showToast("That file offer is not a valid fud:// link.");
        break;
    }
  }

  private copyMessage(text: string) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
    }
    this.showToast("Message copied to clipboard");
  }

  private renderChatBody(text: string) {
    return lexChat(text).map((span) => {
      switch (span.kind) {
        case "url":
          return html`<a
            class="chat-link"
            href=${span.value}
            target="_blank"
            rel="noopener noreferrer"
            @click=${(e: Event) => this.onChatLink(e, span.value)}
            >${span.value}</a
          >`;
        case "fud":
          return html`<span class="chat-fud">${span.value}</span>`;
        default:
          return html`${span.value}`;
      }
    });
  }

  private async onChatLink(e: Event, url: string) {
    if (!isClearnetHttp(url)) return;
    e.preventDefault();
    const open = window.confirm(
      "This http(s) link leaves Nym/Tor and can reveal your IP. Open it in the system browser?",
    );
    if (open) {
      try {
        await openUrl(url);
      } catch (err: unknown) {
        this.error = formatInvokeError(err);
      }
    }
  }

  private payInvoice(raw: string) {
    stageChatPayContext({
      raw,
      channel: this.channel,
      dmMode: this.dmMode,
      peerPublic: this.dmMode && this.peerPublic.trim() ? this.peerPublic.trim() : undefined,
      receiptId: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    });
    this.dispatchEvent(
      new CustomEvent("open-transfer", {
        detail: "send",
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async postPaymentReceipt(detail: ChatReceiptDetail) {
    const targetChannel = detail.context?.channel?.trim() || this.channel;
    const key = chanKey(targetChannel);
    const nick = this.nick || (await api.getChatNick().catch(() => "")) || "me";
    // Nick threads are saltbox-encrypted by the daemon. A second JS layer
    // would hide the receipt from Android and iOS.
    const wireBody = detail.encoded;

    try {
      const optimistic: ChatMessage = {
        eventId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        channel: targetChannel,
        nick,
        message: detail.encoded,
        timestamp: Date.now(),
        isOutgoing: true,
      };
      const prior = this.channelMessages[key] ?? [];
      this.channelMessages[key] = [...prior, optimistic].slice(-500);
      if (sameChannel(targetChannel, this.channel)) {
        this.messages = this.channelMessages[key];
      }
      await this.deliverChat(targetChannel, wireBody);
    } catch (e: unknown) {
      this.pushSystem(
        `Payment receipt saved locally (chat relay unavailable: ${formatInvokeError(e)})`,
        targetChannel,
      );
    }
  }

  private openInlineRequest() {
    this.requestAmount = "";
    this.requestMemo = "";
    this.requestError = "";
    this.showRequestModal = true;
  }

  private async submitInlineRequest() {
    const amt = this.requestAmount.trim();
    if (amt && !isValidDrkAmount(amt)) {
      this.requestError = "Enter a valid DRK amount (up to 8 decimal places)";
      return;
    }
    this.requestError = "";
    try {
      const address = (await api.walletAddress()).trim();
      if (!address) {
        this.requestError = "Wallet address is not ready yet.";
        return;
      }
      this.draft = buildPaymentUri(
        address,
        amt || undefined,
        this.requestMemo.trim() || undefined,
      );
      this.showRequestModal = false;
      await this.send();
    } catch (e: unknown) {
      this.requestError = formatInvokeError(e);
    }
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
    if (
      this.dmKeys &&
      !window.confirm(
        "Rotate your DM keypair? Existing contacts will need your new public key to exchange encrypted DMs.",
      )
    ) {
      return;
    }
    try {
      this.dmKeys = await api.dmGenerateKeypair();
      this.error = "";
      this.showToast(this.dmKeys ? "DM keypair ready" : "");
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
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
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
      this.status = await api.chatStatus().catch(() => "failed");
      if (this.autoReconnect && this.wasConnected) {
        this.scheduleReconnect();
      } else {
        this.stopStatusPoll();
      }
    }
  }

  private async saveContact() {
    const peerPk = this.peerPublic.trim();
    if (!peerPk) {
      this.error = "Enter peer public key first";
      return;
    }
    try {
      this.dmContacts = await api.dmContactsUpsert(
        this.dmContactLabel,
        peerPk,
      );
      this.dmContactLabel = "";
      this.error = "";
      this.showToast("DM contact saved");
      const saved = this.dmContacts.find((c) => c.publicB58 === peerPk);
      if (saved) {
        await this.selectContact(saved);
      }
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private async selectContact(c: DmContact) {
    this.peerPublic = c.publicB58;
    this.dmMode = true;
    const label = c.label.trim();
    if (label && !label.startsWith("#")) {
      if (!this.channelsList.some((ch) => sameChannel(ch, label))) {
        this.channelsList = [...this.channelsList, label];
      }
      this.switchChannel(label);
    }
    if (c.unread > 0) {
      this.dmContacts = clearDmUnread(this.dmContacts, c.publicB58);
      try {
        await api.dmContactsClearUnread(c.publicB58);
      } catch {
        /* ignore */
      }
    }
  }

  private async deleteContact(id: string) {
    try {
      this.dmContacts = await api.dmContactsRemove(id);
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
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
          } catch (e: unknown) {
            const msg = formatInvokeError(e);
            this.error = msg;
            this.pushSystem(msg);
          }
          return;
        }
        case "/join": {
          if (!arg) {
            this.pushSystem("Usage: /join <#channel>");
            return;
          }
          const normalized = arg.startsWith("#") ? arg : `#${arg}`;
          const targetChan = chanKey(normalized);
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
            this.channelsList = [DEFAULT_SELECTED_CHANNEL];
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
            await this.deliverChat(this.channel, actionText);
          } catch (e: unknown) {
            this.error = formatInvokeError(e);
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
            await this.deliverChat(target, msgContent);
            this.pushSystem(`→ ${target}: ${msgContent}`);
          } catch (e: unknown) {
            this.error = formatInvokeError(e);
          }
          return;
        }
        case "/whoami": {
          try {
            this.nick = await api.getChatNick();
            this.pushSystem(`You are ${this.nick || "(unnamed)"} on ${this.channel}`);
          } catch (e: unknown) {
            this.error = formatInvokeError(e);
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
      const body = text;
      const displayBody = text;
      if (this.dmMode && this.channel.trim().startsWith("#")) {
        this.error = "Select or save a DM contact first — public #channels are not encrypted";
        return;
      }
      if (threadIsEncrypted(this.dmMode, this.channel)) {
        if (!this.dmKeys || !this.peerPublic.trim()) {
          this.error = "Generate DM keys and set peer public key first";
          return;
        }
      }
      const nick = this.nick || (await api.getChatNick()) || "me";
      this.pushOptimistic(nick, displayBody);
      await this.deliverChat(this.channel, body);
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private pushOptimistic(nick: string, message: string) {
    const m: ChatMessage = {
      eventId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channel: this.channel,
      nick,
      message,
      timestamp: Date.now(),
      isOutgoing: true,
    };
    // Don't add to seenEventIds — network echo uses a different event id.
    const key = chanKey(this.channel);
    const prior = this.channelMessages[key] ?? [];
    this.channelMessages[key] = [...prior, m].slice(-500);
    this.messages = this.channelMessages[key];
  }

  private openNewDm() {
    this.dmMode = true;
    this.showToast("New conversation — paste a peer key or pick a contact");
  }

  private openRequest() {
    this.dispatchEvent(
      new CustomEvent("open-transfer", {
        detail: "request",
        bubbles: true,
        composed: true,
      }),
    );
  }

  private openNetworkInfo() {
    this.showToast(
      `Network: ${ChatScreen.phaseLabel(this.status)}${this.nick ? ` · @${this.nick}` : ""}`,
    );
  }

  private openChatSettings() {
    this.dispatchEvent(
      new CustomEvent("open-chat-settings", {
        bubbles: true,
        composed: true,
      }),
    );
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
          · ${threadIsEncrypted(this.dmMode, this.channel) ? "Direct · E2E" : "Public channel"}
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
        <div class="chrome-actions" role="toolbar" aria-label="Chat actions">
          <button
            class="icon"
            title="New conversation"
            aria-label="New conversation"
            @click=${this.openNewDm}
          >
            +
          </button>
          <button
            class="icon"
            title="Request"
            aria-label="Request"
            @click=${this.openRequest}
          >
            ⎘
          </button>
          <button
            class="icon"
            title="Network"
            aria-label="Network"
            @click=${this.openNetworkInfo}
          >
            ℹ
          </button>
          <button
            class="icon"
            title="Chat Settings"
            aria-label="Chat Settings"
            @click=${this.openChatSettings}
          >
            ⚙
          </button>
        </div>
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
                          <div
                            class="contact ${c.publicB58 === this.peerPublic
                              ? "selected"
                              : ""}"
                          >
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
          ${this.messages.map((m) => {
            const own =
              typeof m.isOutgoing === "boolean"
                ? m.isOutgoing
                : isOwnNick(m.nick, this.nick);
            const nickClass =
              m.nick === "System" ? "nick" : own ? "nick own" : `nick h${peerNickIndex(m.nick)}`;
            return html`
              <div
                class="m ${m.nick === "System" ? "system" : own ? "mine" : "peer"} ${threadIsEncrypted(
                  this.dmMode,
                  this.channel,
                )
                  ? "encrypted"
                  : ""}"
                title="Click, long press, or right-click to copy"
                @contextmenu=${(e: MouseEvent) => {
                  e.preventDefault();
                  this.copyMessage(m.message);
                }}
                @touchstart=${() => this.handleTouchStart(m.message)}
                @touchend=${() => this.handleTouchEnd()}
                @touchcancel=${() => this.handleTouchEnd()}
              >
                <span class=${nickClass}>&lt;${m.nick}&gt;</span>
                <span class="content">${this.renderChatBody(m.message)}</span>
                ${hasFud(m.message)
                  ? html`<button
                      class="fud-hint"
                      @click=${(e: Event) => {
                        e.stopPropagation();
                        this.queueOffer(m.message);
                      }}
                    >
                      Queue file offer
                    </button>`
                  : null}
                ${(() => {
                  const invoice = findInvoice(m.message);
                  if (!invoice) return null;
                  return html`<div class="pay-card">
                    <div class="pay-title">Payment request${invoice.amount ? html` · ${invoice.amount} DRK` : ""}</div>
                    ${invoice.memo ? html`<div class="status">${invoice.memo}</div>` : null}
                    <button
                      class="primary"
                      @click=${(e: Event) => {
                        e.stopPropagation();
                        this.payInvoice(invoice.raw);
                      }}
                    >
                      Pay
                    </button>
                  </div>`;
                })()}
                ${(() => {
                  const receipt = parseReceipt(m.message);
                  if (!receipt) return null;
                  return html`<div class="pay-card">
                    <div class="pay-title">Payment ${receipt.phase} · ${receipt.amount} DRK</div>
                    ${receipt.txId ? html`<div class="pay-tx">${receipt.txId}</div>` : null}
                  </div>`;
                })()}
              </div>
            `;
          })}
        </div>
      </div>
      ${this.toastMessage
        ? html`<div class="toast">${this.toastMessage}</div>`
        : null}
      <div class="composer">
        <input
          placeholder=${threadIsEncrypted(this.dmMode, this.channel)
            ? "Encrypted message…"
            : "Message or /command…"}
          .value=${this.draft}
          @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.send()}
          @input=${(e: Event) =>
            (this.draft = (e.target as HTMLInputElement).value)}
        />
        <button @click=${() => this.openInlineRequest()}>Request</button>
        <button class="primary" @click=${this.send}>Send</button>
      </div>
      ${this.error ? html`<p class="err">${this.error}</p>` : null}
      ${this.showRequestModal
        ? html`
            <div
              class="req-modal-overlay"
              @click=${(e: Event) => {
                if (e.target === e.currentTarget) this.showRequestModal = false;
              }}
            >
              <div class="req-modal">
                <h3>Post Payment Request</h3>
                <label>Amount (DRK, optional)</label>
                <input
                  placeholder="e.g. 1.5"
                  .value=${this.requestAmount}
                  @keydown=${(e: KeyboardEvent) =>
                    e.key === "Enter" && this.submitInlineRequest()}
                  @input=${(e: Event) =>
                    (this.requestAmount = (e.target as HTMLInputElement).value)}
                />
                <label
                  >Memo (optional, ${utf8ByteLength(this.requestMemo)}/${MAX_PAYMENT_MEMO_BYTES}
                  UTF-8 bytes)</label
                >
                <input
                  placeholder="Optional note"
                  .value=${this.requestMemo}
                  @keydown=${(e: KeyboardEvent) =>
                    e.key === "Enter" && this.submitInlineRequest()}
                  @input=${(e: Event) =>
                    (this.requestMemo = truncateUtf8Bytes(
                      (e.target as HTMLInputElement).value,
                    ))}
                />
                ${this.requestError
                  ? html`<p class="err">${this.requestError}</p>`
                  : null}
                <div class="req-modal-actions">
                  <button @click=${() => (this.showRequestModal = false)}>
                    Cancel
                  </button>
                  <button class="primary" @click=${this.submitInlineRequest}>
                    Post Request
                  </button>
                </div>
              </div>
            </div>
          `
        : null}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-screen": ChatScreen;
  }
}
