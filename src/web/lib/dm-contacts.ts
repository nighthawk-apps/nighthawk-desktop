/**
 * DM contact helpers and legacy web-storage cleanup.
 *
 * Authoritative DM contacts & keypairs live in encrypted Rust storage
 * (`dm_contacts.sealed` / `dm_keypair.sealed`) and in-memory FFI (`DM_CONTACTS`).
 */

export interface DmContact {
  id: string;
  label: string;
  publicB58: string;
  lastSeenAt: number;
  unread: number;
}

export const LEGACY_DM_CONTACTS_KEY = "nighthawk.dm.contacts.v1";
export const LEGACY_DM_KEYPAIR_KEY = "nighthawk.dm.keypair";

/** Read legacy plaintext `localStorage` DM contacts once for migration to Rust. */
export function readLegacyDmContacts(
  storage: Pick<Storage, "getItem"> = localStorage,
): DmContact[] {
  try {
    const raw = storage.getItem(LEGACY_DM_CONTACTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is DmContact =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as DmContact).publicB58 === "string" &&
        (item as DmContact).publicB58.trim().length > 0,
    );
  } catch {
    return [];
  }
}

/** Scrub all legacy DM secrets/contacts from browser storage (`localStorage` / `sessionStorage`). */
export function clearLegacyDmStorage(
  localStore: Pick<Storage, "removeItem" | "length" | "key"> = localStorage,
  sessionStore?: Pick<Storage, "removeItem" | "length" | "key">,
): void {
  const scrub = (store: Pick<Storage, "removeItem" | "length" | "key">) => {
    try {
      store.removeItem(LEGACY_DM_CONTACTS_KEY);
      store.removeItem(LEGACY_DM_KEYPAIR_KEY);
      const keysToDelete: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.startsWith("nighthawk.dm.")) {
          keysToDelete.push(k);
        }
      }
      for (const k of keysToDelete) {
        store.removeItem(k);
      }
    } catch {
      /* ignore unavailable storage */
    }
  };
  scrub(localStore);
  if (sessionStore) {
    scrub(sessionStore);
  } else if (typeof sessionStorage !== "undefined") {
    scrub(sessionStorage);
  }
}

export function upsertDmContact(
  contacts: DmContact[],
  input: { label: string; publicB58: string },
): DmContact[] {
  const publicB58 = input.publicB58.trim();
  const label = input.label.trim() || publicB58.slice(0, 12);
  if (!publicB58) return contacts;
  const idx = contacts.findIndex((c) => c.publicB58 === publicB58);
  if (idx >= 0) {
    const next = [...contacts];
    next[idx] = {
      ...next[idx],
      label,
      lastSeenAt: Date.now(),
    };
    return next;
  }
  return [
    {
      id: `dm-${Date.now()}`,
      label,
      publicB58,
      lastSeenAt: Date.now(),
      unread: 0,
    },
    ...contacts,
  ];
}

export function removeDmContact(
  contacts: DmContact[],
  id: string,
): DmContact[] {
  return contacts.filter((c) => c.id !== id);
}

export function bumpDmUnread(
  contacts: DmContact[],
  publicB58: string,
): DmContact[] {
  const idx = contacts.findIndex((c) => c.publicB58 === publicB58);
  if (idx < 0) return contacts;
  const next = [...contacts];
  next[idx] = {
    ...next[idx],
    unread: next[idx].unread + 1,
    lastSeenAt: Date.now(),
  };
  return next;
}

export function clearDmUnread(
  contacts: DmContact[],
  publicB58: string,
): DmContact[] {
  const idx = contacts.findIndex((c) => c.publicB58 === publicB58);
  if (idx < 0) return contacts;
  const next = [...contacts];
  next[idx] = { ...next[idx], unread: 0 };
  return next;
}
