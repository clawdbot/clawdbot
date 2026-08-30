import { createHash } from "node:crypto";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";

export type WarmImageRecord = {
  checkpointId: string;
  kind: string;
  state: "pending" | "available";
  createdAtMs: number;
  lastUsedAtMs: number;
  operation?:
    | {
        type: "capture";
        id: string;
        startedAtMs: number;
        leaseId: string;
        provider: string;
        phase: "scrubbing" | "creating" | "uncertain";
      }
    | { type: "retire"; checkpointId: string };
};

export const WARM_IMAGE_MAX_ENTRIES = 128;
// Longer than scrub plus the slowest capture budget; diagnostic only, never a claim expiry.
const CAPTURE_WARNING_AGE_MS = 1_200_000;

export function openCrabboxWarmImageStore(env?: NodeJS.ProcessEnv) {
  return createPluginStateSyncKeyedStore<WarmImageRecord>("crabbox", {
    namespace: "warm-images",
    maxEntries: WARM_IMAGE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    ...(env ? { env } : {}),
  });
}

export function withoutCrabboxWarmImageOperation(record: WarmImageRecord): WarmImageRecord {
  const image = { ...record };
  delete image.operation;
  return image;
}

export function crabboxWarmImageCaptureStatus(key: string, record: WarmImageRecord) {
  const capture = record.operation?.type === "capture" ? record.operation : undefined;
  if (!capture && (record.checkpointId || record.operation)) {
    return undefined;
  }
  // Older empty markers have no generation. Their exact observed bytes, including
  // the key, identify manual recovery without asserting that no artifact exists.
  const selector = capture
    ? capture.id
    : `legacy-${createHash("sha256").update(JSON.stringify({ key, record })).digest("hex")}`;
  const startedAtMs = capture?.startedAtMs ?? record.createdAtMs;
  return {
    selector,
    startedAtMs,
    ...(capture
      ? { leaseId: capture.leaseId, provider: capture.provider, phase: capture.phase }
      : {}),
    stale: !capture || Date.now() - startedAtMs >= CAPTURE_WARNING_AGE_MS,
  };
}

export function isCrabboxWarmImageCapturePaused(
  capture: NonNullable<ReturnType<typeof crabboxWarmImageCaptureStatus>>,
): boolean {
  return capture.stale || capture.phase === "uncertain";
}

export function crabboxWarmImageRecoveryHint(selector: string): string {
  return `Stop the owning Gateway and capture processes and resolve any untracked checkpoint in the Crabbox catalog before running: openclaw crabbox warm-images --recover ${selector} --acknowledge-provider-cleanup. Then restart the Gateway; the next eligible worker stop can capture again.`;
}

export function listCrabboxWarmImages(env?: NodeJS.ProcessEnv) {
  return openCrabboxWarmImageStore(env)
    .entries()
    .map(({ key, value }) => ({
      profileKey: key,
      checkpointId: value.checkpointId || undefined,
      state: value.state,
      createdAtMs: value.createdAtMs,
      lastUsedAtMs: value.lastUsedAtMs,
      capture: crabboxWarmImageCaptureStatus(key, value),
      retirement:
        value.operation?.type === "retire"
          ? { checkpointId: value.operation.checkpointId }
          : undefined,
    }));
}

/** Clears only a capture whose exact generation the caller owns or has acknowledged. */
export function clearCrabboxWarmImageCapture(key: string, selector: string): boolean {
  const store = openCrabboxWarmImageStore();
  const matches = (current: WarmImageRecord) =>
    crabboxWarmImageCaptureStatus(key, current)?.selector === selector;
  if (store.deleteIf?.(key, (current) => !current.checkpointId && matches(current))) {
    return true;
  }
  return Boolean(
    store.update?.(key, (current) =>
      current && matches(current) ? withoutCrabboxWarmImageOperation(current) : undefined,
    ),
  );
}

export function recoverCrabboxWarmImageCapture(
  selector: string,
  acknowledgeProviderCleanup: boolean,
): void {
  if (!acknowledgeProviderCleanup) {
    throw new Error(
      "Recovery requires --acknowledge-provider-cleanup: confirm the original Gateway/capture processes are stopped and any untracked provider artifact has been resolved. No state was changed.",
    );
  }
  const entry = openCrabboxWarmImageStore()
    .entries()
    .find(({ key, value }) => crabboxWarmImageCaptureStatus(key, value)?.selector === selector);
  if (!entry || !clearCrabboxWarmImageCapture(entry.key, selector)) {
    throw new Error(
      "Capture selector is absent or changed; rerun openclaw crabbox warm-images --json. No state was changed.",
    );
  }
}
