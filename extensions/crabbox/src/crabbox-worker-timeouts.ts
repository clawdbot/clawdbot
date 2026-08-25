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
// AWS coordinator heartbeat latency reached 107.6 seconds in production measurements.
export const CRABBOX_HEARTBEAT_TIMEOUT_MS = 150_000;

// `providers --json` is a static compiled report: no network, no credentials,
// measured well under a second. The picker awaits it, so cap it far below the
// lifecycle budget — a hung binary must fall back to label-only choices
// promptly instead of stalling the whole cloud picker.
export const CRABBOX_MACHINE_CATALOG_TIMEOUT_MS = 5_000;
// Fixed-lease inspection can follow warmup's final read; allow four one-minute retries.
const CRABBOX_MACHINE0_LIFECYCLE_TIMEOUT_MS = 5 * 60_000;
// Setup gets its own budget on top of provision so a slow warmup cannot starve it.
// Setup may install an exact candidate CLI and official plugins on a minimal cloud image.
export const CRABBOX_SETUP_TIMEOUT_MS = 15 * 60_000;
export const CRABBOX_NODE_ENROLLMENT_TIMEOUT_MS = 15 * 60_000;

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
    resolveCrabboxLifecycleTimeoutMs(profile.provider)
  );
}
