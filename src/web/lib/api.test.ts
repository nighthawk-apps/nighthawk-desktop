import {
  formatInvokeError,
  prefsFeeTier,
  spendReady,
  type LightSyncState,
  type Prefs,
} from "./api.ts";

// formatInvokeError tests
if (formatInvokeError("plain error") !== "plain error") {
  throw new Error("string error failed");
}
if (formatInvokeError(new Error("boom")) !== "boom") {
  throw new Error("Error instance failed");
}
if (formatInvokeError({ message: "rpc failed" }) !== "rpc failed") {
  throw new Error("object.message failed");
}
if (formatInvokeError({ error: "vault locked" }) !== "vault locked") {
  throw new Error("object.error failed");
}
const jsonObj = formatInvokeError({ code: 42 });
if (jsonObj.includes("[object Object]") || !jsonObj.includes("42")) {
  throw new Error(`object serialization failed: ${jsonObj}`);
}

const redacted = formatInvokeError(
  "failed to reach https://secret.example.com:9067 or tcp+tls://10.0.0.1:443 from 192.168.1.55:18347",
);
if (
  redacted.includes("secret.example.com") ||
  redacted.includes("10.0.0.1") ||
  redacted.includes("192.168.1.55") ||
  !redacted.includes("[redacted-url]") ||
  !redacted.includes("[redacted-addr]")
) {
  throw new Error(`redaction failed: ${redacted}`);
}

// spendReady tests
function snap(overrides: Partial<LightSyncState> = {}): LightSyncState {
  return {
    status: "Synced",
    syncType: "TrialDecrypt",
    statusMessage: "Synced",
    syncTypeMessage: "",
    scannedHeight: 500,
    chainTip: 500,
    omrAvailable: false,
    syncMethod: "TrialDecrypt",
    fallbackReason: "None",
    fallbackUserMessage: "",
    protoVersionMismatch: false,
    ...overrides,
  };
}

if (spendReady(null)) throw new Error("null snap must not be spendReady");
if (spendReady(snap({ protoVersionMismatch: true }))) {
  throw new Error("protoVersionMismatch must block spendReady");
}
if (spendReady(snap({ chainTip: 0, scannedHeight: 0 }))) {
  throw new Error("zero tip must block spendReady");
}
if (spendReady(snap({ scannedHeight: 499, chainTip: 500 }))) {
  throw new Error("cursor behind tip must block spendReady");
}
if (spendReady(snap({ status: "Syncing" }))) {
  throw new Error("Syncing status must block spendReady");
}
if (!spendReady(snap({ status: "Synced", scannedHeight: 500, chainTip: 500 }))) {
  throw new Error("Synced at tip must be spendReady");
}
if (!spendReady(snap({ status: "Degraded", scannedHeight: 500, chainTip: 500 }))) {
  throw new Error("Degraded at tip must be spendReady");
}

// prefsFeeTier tests
const basePrefs = { feeTier: "normal" } as Prefs;
if (prefsFeeTier({ ...basePrefs, feeTier: "economy" }) !== "economy") {
  throw new Error("economy tier not preserved");
}
if (prefsFeeTier({ ...basePrefs, feeTier: "priority" }) !== "priority") {
  throw new Error("priority tier not preserved");
}
if (prefsFeeTier({ ...basePrefs, feeTier: "bogus" as unknown as "normal" }) !== "normal") {
  throw new Error("unknown feeTier must fall back to normal");
}

console.log("api.test.ts ok");
