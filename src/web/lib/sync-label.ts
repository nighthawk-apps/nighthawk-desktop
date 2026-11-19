import type { LightSyncState } from "./api";

export function isLightSyncLive(snap: LightSyncState): boolean {
  return ["Synced", "Syncing", "Scanning"].includes(snap.status);
}

export function formatLightSyncMethod(snap: LightSyncState): string {
  const m = snap.syncMethod || snap.syncType || "Unknown";
  const base = /unifomr|omr/i.test(m)
    ? "UnifOMR"
    : /trial/i.test(m)
      ? "Trial decrypt"
      : m;
  if (snap.status === "Connecting") return `${base} · connecting`;
  if (snap.status === "Degraded") return `${base} · fallback`;
  if (!isLightSyncLive(snap)) return `${base} · not connected`;
  return base;
}

export function formatLightSyncBanner(snap: LightSyncState): string {
  return `${formatLightSyncMethod(snap)} · ${snap.scannedHeight}/${snap.chainTip} · ${snap.statusMessage}`;
}

