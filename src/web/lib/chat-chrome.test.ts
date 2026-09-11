import {
  CHAT_CHROME,
  hasFud,
  isOwnNick,
  lexChat,
  peerNickIndex,
  threadIsEncrypted,
} from "./chat-chrome.ts";

if (!isOwnNick("HawkOne", "hawkone")) {
  throw new Error("own nick must be case-insensitive");
}

if (peerNickIndex("alice") !== peerNickIndex("ALICE")) {
  throw new Error("peer nick hash must be case-insensitive");
}

if (!CHAT_CHROME.peerNicks.includes(CHAT_CHROME.peerNicks[peerNickIndex("alice")])) {
  throw new Error("peer nick must land in the Stealth palette");
}

if (!threadIsEncrypted(true, "alice", [])) {
  throw new Error("direct inbox is encrypted");
}

if (!threadIsEncrypted(false, "#dev", ["#Dev"])) {
  throw new Error("channel with stored secret is encrypted");
}

if (threadIsEncrypted(false, "#dev", [])) {
  throw new Error("public channel is not encrypted");
}

const spans = lexChat("see https://dark.fi/docs and fud://QmHash/file.png thanks.");
if (spans[0]?.kind !== "text" || spans[0].value !== "see ") {
  throw new Error(`unexpected first span ${JSON.stringify(spans[0])}`);
}
if (spans[1]?.kind !== "url" || spans[1].value !== "https://dark.fi/docs") {
  throw new Error(`unexpected url span ${JSON.stringify(spans[1])}`);
}
if (!hasFud("fud://abc")) {
  throw new Error("fud lexer missed fud://");
}

console.log("chat-chrome.test.ts ok");
