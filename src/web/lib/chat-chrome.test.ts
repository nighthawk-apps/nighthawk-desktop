import {
  CHAT_CHROME,
  decideFud,
  hasFud,
  isOwnNick,
  lexChat,
  parseFud,
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

const offer = parseFud("fud://Abcd/notes.txt");
if (!offer || offer.infoHash !== "abcd" || offer.fileName !== "notes.txt") {
  throw new Error(`parseFud failed: ${JSON.stringify(offer)}`);
}
if (parseFud("fud://ab/../x")) {
  throw new Error("path traversal must be rejected");
}
if (decideFud(true, true, offer) !== "allowed") {
  throw new Error("tor + enabled should queue");
}
if (decideFud(false, true, offer) !== "disabled") {
  throw new Error("toggle off should disable");
}
if (decideFud(true, false, offer) !== "needsPrivateTransport") {
  throw new Error("clearnet should be rejected");
}

console.log("chat-chrome.test.ts ok");
