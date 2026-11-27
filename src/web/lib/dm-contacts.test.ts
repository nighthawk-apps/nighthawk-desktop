import {
  LEGACY_DM_CONTACTS_KEY,
  LEGACY_DM_KEYPAIR_KEY,
  bumpDmUnread,
  clearDmUnread,
  clearLegacyDmStorage,
  parseNighthawkContactInput,
  readLegacyDmContacts,
  upsertDmContact,
} from "./dm-contacts.ts";

class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

const localMem = new MemoryStorage();
const sessionMem = new MemoryStorage();
localMem.setItem(
  LEGACY_DM_CONTACTS_KEY,
  JSON.stringify([
    { id: "dm-1", label: "Alice", publicB58: "PkAlice", lastSeenAt: 10, unread: 1 },
    { id: "bad", label: "Empty", publicB58: "   ", lastSeenAt: 10, unread: 0 },
  ]),
);
localMem.setItem(LEGACY_DM_KEYPAIR_KEY, '{"secret":"should-not-remain"}');
localMem.setItem("nighthawk.dm.extra", "secret");
sessionMem.setItem("nighthawk.dm.sessionSecret", "secret");

const legacy = readLegacyDmContacts(localMem);
if (legacy.length !== 1 || legacy[0].label !== "Alice" || legacy[0].publicB58 !== "PkAlice") {
  throw new Error(`unexpected legacy contacts: ${JSON.stringify(legacy)}`);
}

clearLegacyDmStorage(localMem, sessionMem);
if (
  localMem.getItem(LEGACY_DM_CONTACTS_KEY) !== null ||
  localMem.getItem(LEGACY_DM_KEYPAIR_KEY) !== null ||
  localMem.getItem("nighthawk.dm.extra") !== null ||
  sessionMem.getItem("nighthawk.dm.sessionSecret") !== null
) {
  throw new Error("legacy DM secrets/contacts were not scrubbed");
}

// Exact-case Base58 distinction
let contacts = upsertDmContact([], { label: "Alice", publicB58: "AbcDef" });
contacts = upsertDmContact(contacts, { label: "Bob", publicB58: "abcdef" });
if (contacts.length !== 2) {
  throw new Error("case-distinct Base58 public keys must stay distinct");
}

contacts = bumpDmUnread(contacts, "AbcDef");
const alice = contacts.find((c) => c.publicB58 === "AbcDef");
if (!alice || alice.unread !== 1) {
  throw new Error("bumpDmUnread must increment unread count for matching contact");
}
contacts = clearDmUnread(contacts, "AbcDef");
if (contacts.find((c) => c.publicB58 === "AbcDef")?.unread !== 0) {
  throw new Error("clearDmUnread must reset unread count to 0");
}

const iosCard = parseNighthawkContactInput(
  "nighthawk://contact?nick=Alice&dm=PkAliceIos111&dr=1",
);
if (iosCard.publicB58 !== "PkAliceIos111" || iosCard.label !== "Alice" || !iosCard.ratchetCapable) {
  throw new Error(`failed to parse iOS contact card: ${JSON.stringify(iosCard)}`);
}

const androidCard = parseNighthawkContactInput(
  "nighthawk://contact?k=PkBobAnd111&name=Bob&dr=1",
);
if (androidCard.publicB58 !== "PkBobAnd111" || androidCard.label !== "Bob" || !androidCard.ratchetCapable) {
  throw new Error(`failed to parse Android contact card: ${JSON.stringify(androidCard)}`);
}
