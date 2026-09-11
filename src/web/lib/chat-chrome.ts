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
