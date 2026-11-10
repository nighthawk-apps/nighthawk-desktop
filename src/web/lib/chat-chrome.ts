/** Stealth chat chroma shared with Android `ChatChrome` / iOS `ChatChrome`. */

export const CHAT_CHROME = {
  ownNick: "#5E9BAF",
  link: "#7DADB9",
  fud: "#8F98A3",
  bodyIncoming: "#C4CBD4",
  bodyOutgoing: "#E8EBEF",
  timestamp: "#8F98A3",
  bubbleIncoming: "#171C22",
  bubbleOutgoing: "#243038",
  peerNicks: [
    "#7DADB9",
    "#7AA3F3",
    "#9BBDCF",
    "#9DEA79",
    "#A8B2BD",
    "#9C5776",
    "#4F8799",
    "#C5CED6",
  ],
} as const;

export type ChatInlineSpan =
  | { kind: "text"; value: string }
  | { kind: "url"; value: string }
  | { kind: "fud"; value: string };

const TOKEN = /(fud:\/\/[^\s]+)|(https?:\/\/[^\s<>"]+)/gi;

export function isOwnNick(nick: string, myNick: string): boolean {
  if (!nick || !myNick) return false;
  return nick.toLowerCase() === myNick.toLowerCase();
}

export function peerNickIndex(nick: string): number {
  let hash = 0;
  const s = nick.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) & 0x7fffffff;
  }
  return hash % CHAT_CHROME.peerNicks.length;
}

export function peerNickColor(nick: string): string {
  return CHAT_CHROME.peerNicks[peerNickIndex(nick)];
}

export function nickColor(nick: string, myNick: string): string {
  if (nick.toLowerCase() === "system") return CHAT_CHROME.timestamp;
  return isOwnNick(nick, myNick) ? CHAT_CHROME.ownNick : peerNickColor(nick);
}

export function bodyColor(isOwn: boolean): string {
  return isOwn ? CHAT_CHROME.bodyOutgoing : CHAT_CHROME.bodyIncoming;
}

export function threadIsEncrypted(
  isDirectInbox: boolean,
  threadKey: string,
  encryptedChannelNames: Iterable<string>,
): boolean {
  if (isDirectInbox) return true;
  const key = threadKey.toLowerCase();
  if (!key) return false;
  for (const name of encryptedChannelNames) {
    if (name.toLowerCase() === key) return true;
  }
  return false;
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.,;)]+$/, "");
}

export function lexChat(text: string): ChatInlineSpan[] {
  if (!text) return [];
  const spans: ChatInlineSpan[] = [];
  let cursor = 0;
  const re = new RegExp(TOKEN.source, TOKEN.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > cursor) {
      spans.push({ kind: "text", value: text.slice(cursor, match.index) });
    }
    if (match[1]) {
      spans.push({ kind: "fud", value: trimTrailingPunctuation(match[1]) });
    } else if (match[2]) {
      spans.push({ kind: "url", value: trimTrailingPunctuation(match[2]) });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    spans.push({ kind: "text", value: text.slice(cursor) });
  }
  return spans;
}

export function hasFud(text: string): boolean {
  return lexChat(text).some((span) => span.kind === "fud");
}

export interface FudUri {
  infoHash: string;
  fileName: string | null;
  raw: string;
}

export type FudDecision = "allowed" | "disabled" | "needsPrivateTransport" | "invalid";

const FUD_ENABLED_KEY = "nighthawk-allow-fud";
const FUD_QUEUE_KEY = "nighthawk-fud-queue";

export function parseFud(raw: string): FudUri | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("fud://")) return null;
  const rest = trimmed.slice(6);
  const slash = rest.indexOf("/");
  const host = (slash < 0 ? rest : rest.slice(0, slash)).replace(/[.,;)]+$/, "");
  const path = slash < 0 ? "" : rest.slice(slash + 1).replace(/[.,;)]+$/, "");
  if (host.length < 4 || host.length > 128 || !/^[A-Za-z0-9]+$/.test(host)) return null;
  if (path.includes("..") || path.includes("/") || path.includes("\\")) return null;
  const fileName = path.length === 0 ? null : path;
  if (fileName && (fileName === "." || fileName.length > 255)) return null;
  const infoHash = host.toLowerCase();
  return {
    infoHash,
    fileName,
    raw: fileName ? `fud://${infoHash}/${fileName}` : `fud://${infoHash}`,
  };
}

/** Offers proceed only when the toggle is on and Tor is the route. */
export function decideFud(
  enabled: boolean,
  privateTransport: boolean,
  uri: FudUri | null,
): FudDecision {
  if (!uri) return "invalid";
  if (!enabled) return "disabled";
  return privateTransport ? "allowed" : "needsPrivateTransport";
}

export function fudOffersEnabled(): boolean {
  return localStorage.getItem(FUD_ENABLED_KEY) === "1";
}

export function setFudOffersEnabled(enabled: boolean) {
  localStorage.setItem(FUD_ENABLED_KEY, enabled ? "1" : "0");
}

export function queueFud(uri: FudUri): FudUri[] {
  const current = listQueuedFud().filter((row) => row.infoHash !== uri.infoHash);
  current.unshift(uri);
  localStorage.setItem(FUD_QUEUE_KEY, JSON.stringify(current.slice(0, 50)));
  return current.slice(0, 50);
}

export function listQueuedFud(): FudUri[] {
  try {
    const raw = localStorage.getItem(FUD_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FudUri[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
