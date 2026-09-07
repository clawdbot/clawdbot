import { isRecord } from "../utils.js";

type ConfigObserveSuspiciousBaseline = {
  bytes: number;
  hasMeta: boolean;
  gatewayMode: string | null;
};

function isUpdateChannelOnlyRoot(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "update") {
    return false;
  }
  const update = value.update;
  if (!isRecord(update)) {
    return false;
  }
  const updateKeys = Object.keys(update);
  return updateKeys.length === 1 && typeof update.channel === "string";
}

export function resolveConfigObserveSuspiciousReasons(params: {
  bytes: number;
  hasMeta: boolean;
  gatewayMode: string | null;
  parsed: unknown;
  lastKnownGood?: ConfigObserveSuspiciousBaseline;
}): string[] {
  const reasons: string[] = [];
  const baseline = params.lastKnownGood;
  if (!baseline) {
    return reasons;
  }
  if (baseline.bytes >= 512 && params.bytes < Math.floor(baseline.bytes * 0.5)) {
    reasons.push(`size-drop-vs-last-good:${baseline.bytes}->${params.bytes}`);
  }
  if (baseline.hasMeta && !params.hasMeta) {
    reasons.push("missing-meta-vs-last-good");
  }
  if (baseline.gatewayMode && !params.gatewayMode) {
    reasons.push("gateway-mode-missing-vs-last-good");
  }
  if (baseline.gatewayMode && isUpdateChannelOnlyRoot(params.parsed)) {
    reasons.push("update-channel-only-root");
  }
  return reasons;
}

// `missing-meta-vs-last-good` is intentionally excluded from auto-restore: the
// writer always stamps `meta`, so a valid config lacking it was hand-authored,
// and restoring would silently revert a read-only load. Observe warns.
export function isRecoverableConfigReadSuspiciousReason(reason: string): boolean {
  return (
    reason === "gateway-mode-missing-vs-last-good" ||
    reason === "update-channel-only-root" ||
    reason.startsWith("size-drop-vs-last-good:")
  );
}

// A valid read whose anomalies recovery would not repair is the operator's
// accepted state (e.g. a hand-authored config without `meta`): the bytes stay
// live, so observation must advance the accepted baseline to them. Recording
// only repairable anomalies would leave a stale pre-edit fingerprint in place
// and let a later recognized clobber restore over the accepted settings.
export function isAcceptedConfigRead(params: { valid: boolean; suspicious: string[] }): boolean {
  return params.valid && !params.suspicious.some(isRecoverableConfigReadSuspiciousReason);
}
