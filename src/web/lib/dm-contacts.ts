/** Local DM contact book (peer ChaCha public keys), persisted in localStorage. */

export interface DmContact {
  id: string;
  label: string;
  publicB58: string;
  lastSeenAt: number;
  unread: number;
}

const KEY = "nighthawk.dm.contacts.v1";

export function loadDmContacts(): DmContact[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DmContact[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveDmContacts(contacts: DmContact[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(contacts.slice(0, 200)));
  } catch {
    /* ignore quota */
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
