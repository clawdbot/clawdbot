type CrabboxProvisionTimeoutProfile = {
  provider: string;
  desktop?: boolean;
  setup?: string;
};

const CRABBOX_ACQUISITION_ENVELOPE_MS = 5 * 60_000;
const CRABBOX_BOOTSTRAP_TIMEOUT_MS = 20 * 60_000;
const CRABBOX_DESKTOP_BOOTSTRAP_TIMEOUT_MS = 45 * 60_000;
const CRABBOX_WARMUP_ATTEMPTS = 2;
// Crabbox allows 20m Linux / 45m desktop bootstrap plus one fresh-lease retry;
// include acquisition for both attempts so OpenClaw cannot preempt readiness.
export const CRABBOX_WARMUP_TIMEOUT_MS =
  CRABBOX_WARMUP_ATTEMPTS * (CRABBOX_ACQUISITION_ENVELOPE_MS + CRABBOX_BOOTSTRAP_TIMEOUT_MS);
export const CRABBOX_DESKTOP_WARMUP_TIMEOUT_MS =
  CRABBOX_WARMUP_ATTEMPTS *
  (CRABBOX_ACQUISITION_ENVELOPE_MS + CRABBOX_DESKTOP_BOOTSTRAP_TIMEOUT_MS);
export const CRABBOX_LIFECYCLE_TIMEOUT_MS = 60_000;
// Crabbox stop resolves twice (10s each), cleans the guest (35s), retries release
// (five 60s attempts + 20s backoff per normal/admin client), then observes cleanup for 5m.
// Reserve all phases plus 10s exit grace; SDK child settlement stays separate.
export const CRABBOX_STOP_TIMEOUT_MS =
  2 * 10_000 + 35_000 + 2 * (5 * 60_000 + 20_000) + 5 * 60_000 + 10_000;
// Process timeout begins termination; allow the SDK's 300ms grace and Windows'
// 5s taskkill to settle before core reports the provider result.
export const CRABBOX_COMMAND_SETTLEMENT_TIMEOUT_MS = 10_000;
// AWS coordinator heartbeat latency reached 107.6 seconds in production measurements.
export const CRABBOX_HEARTBEAT_TIMEOUT_MS = 150_000;

// `providers --json` is a static compiled report; bound picker latency for a hung binary.
// Failed reads leave machine overrides unavailable until a later discovery request succeeds.
export const CRABBOX_MACHINE_CATALOG_TIMEOUT_MS = 5_000;
// Fixed-lease inspection can follow warmup's final read; allow four one-minute retries.
const CRABBOX_MACHINE0_LIFECYCLE_TIMEOUT_MS = 5 * 60_000;
// Setup gets its own budget on top of provision so a slow warmup cannot starve it.
// Setup may install an exact candidate CLI and official plugins on a minimal cloud image.
export const CRABBOX_SETUP_TIMEOUT_MS = 15 * 60_000;
export const CRABBOX_NODE_ENROLLMENT_TIMEOUT_MS = 15 * 60_000;
export const CRABBOX_NODE_ENROLLMENT_DIAGNOSTIC_TIMEOUT_MS = 60_000;

export const WARM_IMAGE_COMMAND_TIMEOUT_MS = 60_000;
// Scrubbing and native submission include SSH/coordinator round trips, not image readiness.
export const WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS = 180_000;
// Match Crabbox checkpoint create's bounded native wait, and pass it explicitly.
export const WARM_IMAGE_NATIVE_WAIT_TIMEOUT_MS = 45 * 60_000;

export function resolveCrabboxCheckpointCaptureTimeoutMs(provider: string): number {
  // Crabbox Machine0 stops/restores with separate default 15m windows; Daytona
  // grants 3m for source recovery after its native wait. Neither is image waiting.
  const sourceLifecycleMs =
    provider === "machine0" ? 30 * 60_000 : provider === "daytona" ? 180_000 : 0;
  return (
    WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS + WARM_IMAGE_NATIVE_WAIT_TIMEOUT_MS + sourceLifecycleMs
  );
}

export function resolveCrabboxWarmImageCaptureTimeoutMs(provider: string): number {
  // Bound collection, verification, missing-image deletion, capacity reclamation,
  // and predecessor retirement as well as scrub/create; core must await the owner.
  return (
    5 * WARM_IMAGE_COMMAND_TIMEOUT_MS +
    WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS +
    resolveCrabboxCheckpointCaptureTimeoutMs(provider) +
    // Each timed-out command must join its child/tree before core closes the owner.
    7 * CRABBOX_COMMAND_SETTLEMENT_TIMEOUT_MS
  );
}

// Leave one minute inside the lifecycle cap for process startup and cleanup handoff.
export const CRABBOX_MACHINE0_READY_WAIT_TIMEOUT = "4m";

// Match Machine0's provider-read cadence; fast re-inspection can exhaust its hourly API budget.
export function resolveCrabboxReadyPollIntervalMs(provider: string): number {
  return provider === "machine0" ? 60_000 : 2_000;
}

export function resolveCrabboxLifecycleTimeoutMs(provider: string): number {
  return provider === "machine0"
    ? CRABBOX_MACHINE0_LIFECYCLE_TIMEOUT_MS
    : CRABBOX_LIFECYCLE_TIMEOUT_MS;
}

export function resolveCrabboxProvisionBaseTimeoutMs(
  profile: CrabboxProvisionTimeoutProfile,
): number {
  const warmupTimeoutMs = profile.desktop
    ? CRABBOX_DESKTOP_WARMUP_TIMEOUT_MS
    : CRABBOX_WARMUP_TIMEOUT_MS;
  const lifecycleTimeoutMs = resolveCrabboxLifecycleTimeoutMs(profile.provider);
  // Machine0 needs separate windows for authoritative inspection and readiness retry.
  return warmupTimeoutMs + lifecycleTimeoutMs * (profile.provider === "machine0" ? 2 : 1);
}

export function countCrabboxProvisionSetupPhases(profile: CrabboxProvisionTimeoutProfile): number {
  return Number(Boolean(profile.desktop)) + Number(Boolean(profile.setup));
}

export function resolveCrabboxProvisionCallTimeoutMs(
  profile: CrabboxProvisionTimeoutProfile,
): number {
  return (
    resolveCrabboxProvisionBaseTimeoutMs(profile) +
    countCrabboxProvisionSetupPhases(profile) * CRABBOX_SETUP_TIMEOUT_MS +
    CRABBOX_NODE_ENROLLMENT_TIMEOUT_MS +
    CRABBOX_NODE_ENROLLMENT_DIAGNOSTIC_TIMEOUT_MS +
    CRABBOX_STOP_TIMEOUT_MS +
    // Diagnostics, heartbeat cancellation, and stop retain child/tree settlement.
    3 * CRABBOX_COMMAND_SETTLEMENT_TIMEOUT_MS
  );
}
