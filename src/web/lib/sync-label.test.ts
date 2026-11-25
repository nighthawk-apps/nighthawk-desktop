import {
  formatLightSyncBanner,
  formatLightSyncMethod,
  isLightSyncLive,
} from "./sync-label.ts";
import type { LightSyncState } from "./api.ts";

function makeSnap(overrides: Partial<LightSyncState> = {}): LightSyncState {
  return {
    status: "Synced",
    syncType: "TrialDecrypt",
    statusMessage: "Up to date",
    syncTypeMessage: "",
    scannedHeight: 100,
    chainTip: 100,
    omrAvailable: false,
    syncMethod: "TrialDecrypt",
    fallbackReason: "None",
    fallbackUserMessage: "",
    protoVersionMismatch: false,
    ...overrides,
  };
}

for (const liveStatus of ["Synced", "Syncing", "Scanning"]) {
  if (!isLightSyncLive(makeSnap({ status: liveStatus }))) {
    throw new Error(`expected ${liveStatus} to be live`);
  }
}

for (const nonLive of ["Connecting", "Degraded", "Error", "Idle", "Disconnected"]) {
  if (isLightSyncLive(makeSnap({ status: nonLive }))) {
    throw new Error(`expected ${nonLive} to NOT be live`);
  }
}

if (formatLightSyncMethod(makeSnap({ syncMethod: "UnifOMR", status: "Synced" })) !== "UnifOMR") {
  throw new Error("live UnifOMR label mismatch");
}

if (
  formatLightSyncMethod(makeSnap({ syncMethod: "TrialDecrypt", status: "Synced" })) !==
  "Trial decrypt"
) {
  throw new Error("live Trial decrypt label mismatch");
}

if (
  formatLightSyncMethod(makeSnap({ syncMethod: "UnifOMR", status: "Connecting" })) !==
  "UnifOMR · connecting"
) {
  throw new Error("connecting label mismatch");
}

if (
  formatLightSyncMethod(makeSnap({ syncMethod: "TrialDecrypt", status: "Degraded" })) !==
  "Trial decrypt · fallback"
) {
  throw new Error("degraded fallback label mismatch");
}

if (
  formatLightSyncMethod(makeSnap({ syncMethod: "TrialDecrypt", status: "Error" })) !==
  "Trial decrypt · not connected"
) {
  throw new Error("not-connected label mismatch");
}

const banner = formatLightSyncBanner(
  makeSnap({
    syncMethod: "UnifOMR",
    status: "Syncing",
    scannedHeight: 42,
    chainTip: 100,
    statusMessage: "Scanning blocks",
  }),
);
if (banner !== "UnifOMR · 42/100 · Scanning blocks") {
  throw new Error(`unexpected banner: ${banner}`);
}

console.log("sync-label.test.ts ok");
