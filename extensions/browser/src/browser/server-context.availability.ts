import fs from "node:fs";
import { resolveCdpReachabilityPolicy } from "./cdp-reachability-policy.js";
import {
  CHROME_MCP_ATTACH_READY_POLL_MS,
  CHROME_MCP_ATTACH_READY_WINDOW_MS,
  PROFILE_ATTACH_RETRY_TIMEOUT_MS,
  PROFILE_POST_RESTART_WS_TIMEOUT_MS,
  resolveCdpReachabilityTimeouts,
} from "./cdp-timeouts.js";
import { redactCdpUrl } from "./cdp.helpers.js";
import { getChromeMcpModule } from "./chrome-mcp.runtime.js";
import {
  diagnoseChromeCdp,
  formatChromeCdpDiagnostic,
  isChromeCdpReady,
  isChromeReachable,
  launchOpenClawChrome,
  stopOpenClawChrome,
} from "./chrome.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { BrowserProfileUnavailableError } from "./errors.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import {
  CDP_READY_AFTER_LAUNCH_MAX_TIMEOUT_MS,
  CDP_READY_AFTER_LAUNCH_MIN_TIMEOUT_MS,
  CDP_READY_AFTER_LAUNCH_POLL_MS,
  CDP_READY_AFTER_LAUNCH_WINDOW_MS,
} from "./server-context.constants.js";
import {
  closePlaywrightBrowserConnectionForProfile,
  resolveIdleProfileStopOutcome,
} from "./server-context.lifecycle.js";
import type {
  BrowserServerState,
  ContextOptions,
  ProfileRuntimeState,
} from "./server-context.types.js";

type AvailabilityDeps = {
  opts: ContextOptions;
  profile: ResolvedBrowserProfile;
  state: () => BrowserServerState;
  getProfileState: () => ProfileRuntimeState;
  setProfileRunning: (running: ProfileRuntimeState["running"]) => void;
};

type AvailabilityOps = {
  isHttpReachable: (timeoutMs?: number) => Promise<boolean>;
  isTransportAvailable: (timeoutMs?: number) => Promise<boolean>;
  isReachable: (timeoutMs?: number) => Promise<boolean>;
  ensureBrowserAvailable: (opts?: { headless?: boolean }) => Promise<void>;
  stopRunningBrowser: () => Promise<{ stopped: boolean }>;
};

type BrowserEnsureOptions = {
  headless?: boolean;
};

const MANAGED_LAUNCH_FAILURE_THRESHOLD = 3;
const MANAGED_LAUNCH_COOLDOWN_BASE_MS = 30_000;
const MANAGED_LAUNCH_COOLDOWN_MAX_MS = 5 * 60_000;

function launchOptionsForEnsure(options?: BrowserEnsureOptions) {
  return typeof options?.headless === "boolean"
    ? { headlessOverride: options.headless }
    : undefined;
}

function ensureOptionsKey(options?: BrowserEnsureOptions): string {
  return typeof options?.headless === "boolean" ? `headless:${options.headless}` : "default";
}

function formatLocalPortOwnershipHint(profile: ResolvedBrowserProfile): string {
  const resetHint =
    `If OpenClaw should own this local profile, run action=reset-profile profile=${profile.name} ` +
    "to stop the conflicting process.";
  if (!profile.cdpIsLoopback) {
    return resetHint;
  }
  return (
    `${resetHint} If this port is an externally managed CDP service such as Browserless, ` +
    `set browser.profiles.${profile.name}.attachOnly=true so OpenClaw attaches without trying ` +
    "to manage the local process. For Browserless Docker, set EXTERNAL to the same WebSocket " +
    "endpoint OpenClaw can reach via browser.profiles.<name>.cdpUrl."
  );
}

function normalizeFailureMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const trimmed = raw.trim();
  return trimmed || "unknown browser launch failure";
}

function resetManagedLaunchFailure(profileState: ProfileRuntimeState): void {
  profileState.managedLaunchFailure = undefined;
}

function recordManagedLaunchFailure(profileState: ProfileRuntimeState, err: unknown): void {
  const previous = profileState.managedLaunchFailure;
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  const exponent = Math.max(0, consecutiveFailures - MANAGED_LAUNCH_FAILURE_THRESHOLD);
  const cooldownMs =
    consecutiveFailures >= MANAGED_LAUNCH_FAILURE_THRESHOLD
      ? Math.min(MANAGED_LAUNCH_COOLDOWN_MAX_MS, MANAGED_LAUNCH_COOLDOWN_BASE_MS * 2 ** exponent)
      : 0;
  const now = Date.now();
  profileState.managedLaunchFailure = {
    consecutiveFailures,
    lastFailureAt: now,
    ...(cooldownMs > 0 ? { cooldownUntil: now + cooldownMs } : {}),
    lastError: normalizeFailureMessage(err),
  };
}

function assertManagedLaunchNotCoolingDown(profileName: string, profileState: ProfileRuntimeState) {
  const failure = profileState.managedLaunchFailure;
  if (!failure || failure.consecutiveFailures < MANAGED_LAUNCH_FAILURE_THRESHOLD) {
    return;
  }
  const cooldownUntil = failure.cooldownUntil ?? 0;
  const remainingMs = cooldownUntil - Date.now();
  if (remainingMs <= 0) {
    return;
  }
  const retrySeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  throw new BrowserProfileUnavailableError(
    `Browser launch for profile "${profileName}" is cooling down after ${failure.consecutiveFailures} consecutive managed Chrome launch failures. ` +
      `Retry in ${retrySeconds}s after fixing Chrome startup, or set browser.enabled=false if the browser tool is not needed. ` +
      `Last error: ${failure.lastError}`,
  );
}

export function createProfileAvailability({
  opts,
  profile,
  state,
  getProfileState,
  setProfileRunning,
}: AvailabilityDeps): AvailabilityOps {
  const redactedProfileCdpUrl = redactCdpUrl(profile.cdpUrl) ?? profile.cdpUrl;
  const capabilities = getBrowserProfileCapabilities(profile);
  const resolveTimeouts = (timeoutMs: number | undefined) =>
    resolveCdpReachabilityTimeouts({
      profileIsLoopback: profile.cdpIsLoopback,
      attachOnly: profile.attachOnly,
      timeoutMs,
      remoteHttpTimeoutMs: state().resolved.remoteCdpTimeoutMs,
      remoteHandshakeTimeoutMs: state().resolved.remoteCdpHandshakeTimeoutMs,
    });

  const getCdpReachabilityPolicy = () =>
    resolveCdpReachabilityPolicy(profile, state().resolved.ssrfPolicy);
  const isReachable = async (timeoutMs?: number) => {
    if (capabilities.usesChromeMcp) {
      // listChromeMcpTabs creates the session if needed — no separate ensureChromeMcpAvailable call required
      const { listChromeMcpTabs } = await getChromeMcpModule();
      await listChromeMcpTabs(profile.name, profile);
      return true;
    }
    const { httpTimeoutMs, wsTimeoutMs } = resolveTimeouts(timeoutMs);
    return await isChromeCdpReady(
      profile.cdpUrl,
      httpTimeoutMs,
      wsTimeoutMs,
      getCdpReachabilityPolicy(),
    );
  };

  const isTransportAvailable = async (timeoutMs?: number) => {
    if (capabilities.usesChromeMcp) {
      const { ensureChromeMcpAvailable } = await getChromeMcpModule();
      await ensureChromeMcpAvailable(profile.name, profile, {
        ephemeral: true,
        timeoutMs,
      });
      return true;
    }
    return await isReachable(timeoutMs);
  };

  const isHttpReachable = async (timeoutMs?: number) => {
    if (capabilities.usesChromeMcp) {
      return await isTransportAvailable(timeoutMs);
    }
    const { httpTimeoutMs } = resolveTimeouts(timeoutMs);
    return await isChromeReachable(profile.cdpUrl, httpTimeoutMs, getCdpReachabilityPolicy());
  };

  const describeCdpFailure = async (timeoutMs?: number): Promise<string> => {
    const { httpTimeoutMs, wsTimeoutMs } = resolveTimeouts(timeoutMs);
    const diagnostic = await diagnoseChromeCdp(
      profile.cdpUrl,
      httpTimeoutMs,
      wsTimeoutMs,
      getCdpReachabilityPolicy(),
    );
    return formatChromeCdpDiagnostic(diagnostic);
  };

  const attachRunning = (running: NonNullable<ProfileRuntimeState["running"]>) => {
    setProfileRunning(running);
    running.proc.on("exit", () => {
      // Guard against server teardown (e.g., SIGUSR1 restart)
      if (!opts.getState()) {
        return;
      }
      const profileState = getProfileState();
      if (profileState.running?.pid === running.pid) {
        setProfileRunning(null);
      }
    });
  };

  const formatChromeMcpAttachFailure = (lastError: unknown): string => {
    const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
    const message = lastError instanceof Error ? lastError.message : "";
    if (message.includes("DevToolsActivePort") || message.includes("Could not connect to Chrome")) {
      return (
        `Chrome MCP existing-session attach for profile "${profile.name}" could not connect to Chrome. ` +
        "Enable remote debugging in the browser inspect page, keep the browser open, approve the attach prompt, and retry. " +
        'If you do not need your signed-in browser session, use the managed "openclaw" profile instead.' +
        detail
      );
    }
    return (
      `Chrome MCP existing-session attach for profile "${profile.name}" timed out waiting for tabs to become available.` +
      ` Approve the browser attach prompt, keep the browser open, and retry.${detail}`
    );
  };

  const reconcileProfileRuntime = async (): Promise<void> => {
    const profileState = getProfileState();
    const reconcile = profileState.reconcile;
    if (!reconcile) {
      return;
    }
    profileState.reconcile = null;
    profileState.lastTargetId = null;

    const previousProfile = reconcile.previousProfile;
    resetManagedLaunchFailure(profileState);
    if (profileState.running) {
      await stopOpenClawChrome(profileState.running).catch(() => {});
      setProfileRunning(null);
    }
    if (getBrowserProfileCapabilities(previousProfile).usesChromeMcp) {
      const { closeChromeMcpSession } = await getChromeMcpModule();
      await closeChromeMcpSession(previousProfile.name).catch(() => false);
    }
    await closePlaywrightBrowserConnectionForProfile(previousProfile.cdpUrl);
    if (previousProfile.cdpUrl !== profile.cdpUrl) {
      await closePlaywrightBrowserConnectionForProfile(profile.cdpUrl);
    }
  };

  const waitForCdpReadyAfterLaunch = async (): Promise<void> => {
    // launchOpenClawChrome() can return before Chrome is fully ready to serve /json/version + CDP WS.
    // If a follow-up call races ahead, we can hit PortInUseError trying to launch again on the same port.
    const deadlineMs =
      Date.now() + (state().resolved.localCdpReadyTimeoutMs ?? CDP_READY_AFTER_LAUNCH_WINDOW_MS);
    while (Date.now() < deadlineMs) {
      const remainingMs = Math.max(0, deadlineMs - Date.now());
      // Keep each attempt short; loopback profiles derive a WS timeout from this value.
      const attemptTimeoutMs = Math.max(
        CDP_READY_AFTER_LAUNCH_MIN_TIMEOUT_MS,
        Math.min(CDP_READY_AFTER_LAUNCH_MAX_TIMEOUT_MS, remainingMs),
      );
      if (await isReachable(attemptTimeoutMs)) {
        return;
      }
      await new Promise((r) => setTimeout(r, CDP_READY_AFTER_LAUNCH_POLL_MS));
    }
    throw new Error(
      `Chrome CDP websocket for profile "${profile.name}" is not reachable after start. ${await describeCdpFailure(
        CDP_READY_AFTER_LAUNCH_MAX_TIMEOUT_MS,
      )}`,
    );
  };

  const waitForChromeMcpReadyAfterAttach = async (): Promise<void> => {
    const deadlineMs = Date.now() + CHROME_MCP_ATTACH_READY_WINDOW_MS;
    let lastError: unknown;
    while (Date.now() < deadlineMs) {
      try {
        const { listChromeMcpTabs } = await getChromeMcpModule();
        await listChromeMcpTabs(profile.name, profile);
        return;
      } catch (err) {
        lastError = err;
      }
      await new Promise((r) => setTimeout(r, CHROME_MCP_ATTACH_READY_POLL_MS));
    }
    throw new BrowserProfileUnavailableError(formatChromeMcpAttachFailure(lastError));
  };

  const launchManagedChrome = async (
    profileState: ProfileRuntimeState,
    current: BrowserServerState,
    launchOptions: ReturnType<typeof launchOptionsForEnsure>,
  ) => {
    assertManagedLaunchNotCoolingDown(profile.name, profileState);
    try {
      return await launchOpenClawChrome(current.resolved, profile, launchOptions);
    } catch (err) {
      recordManagedLaunchFailure(profileState, err);
      throw err;
    }
  };

  const ensureBrowserAvailableOnce = async (options?: BrowserEnsureOptions): Promise<void> => {
    await reconcileProfileRuntime();
    if (capabilities.usesChromeMcp) {
      if (profile.userDataDir && !fs.existsSync(profile.userDataDir)) {
        throw new BrowserProfileUnavailableError(
          `Browser user data directory not found for profile "${profile.name}": ${profile.userDataDir}`,
        );
      }
      const { ensureChromeMcpAvailable } = await getChromeMcpModule();
      await ensureChromeMcpAvailable(profile.name, profile);
      await waitForChromeMcpReadyAfterAttach();
      return;
    }
    const current = state();
    const remoteCdp = capabilities.isRemote;
    const attachOnly = profile.attachOnly;
    const profileState = getProfileState();
    const httpReachable = await isHttpReachable();
    const launchOptions = launchOptionsForEnsure(options);

    if (!httpReachable) {
      if ((attachOnly || remoteCdp) && opts.onEnsureAttachTarget) {
        await opts.onEnsureAttachTarget(profile);
        if (await isHttpReachable(PROFILE_ATTACH_RETRY_TIMEOUT_MS)) {
          return;
        }
      }
      // Browser control service can restart while a loopback OpenClaw browser is still
      // alive. Give that pre-existing browser one longer probe window before falling
      // back to local executable resolution.
      if (!attachOnly && !remoteCdp && profile.cdpIsLoopback && !profileState.running) {
        if (
          (await isHttpReachable(PROFILE_ATTACH_RETRY_TIMEOUT_MS)) &&
          (await isReachable(PROFILE_ATTACH_RETRY_TIMEOUT_MS))
        ) {
          resetManagedLaunchFailure(profileState);
          return;
        }
      }
      if (attachOnly || remoteCdp) {
        throw new BrowserProfileUnavailableError(
          remoteCdp
            ? `Remote CDP for profile "${profile.name}" is not reachable at ${redactedProfileCdpUrl}.`
            : `Browser attachOnly is enabled and profile "${profile.name}" is not running.`,
        );
      }
      const launched = await launchManagedChrome(profileState, current, launchOptions);
      attachRunning(launched);
      try {
        await waitForCdpReadyAfterLaunch();
        resetManagedLaunchFailure(profileState);
      } catch (err) {
        await stopOpenClawChrome(launched).catch(() => {});
        setProfileRunning(null);
        recordManagedLaunchFailure(profileState, err);
        throw err;
      }
      return;
    }

    // Port is reachable - check if we own it.
    if (await isReachable()) {
      resetManagedLaunchFailure(profileState);
      return;
    }

    // HTTP responds but WebSocket fails. For attachOnly/remote profiles, never perform
    // local ownership/restart handling; just run attach retries and surface attach errors.
    if (attachOnly || remoteCdp) {
      if (opts.onEnsureAttachTarget) {
        await opts.onEnsureAttachTarget(profile);
        if (await isReachable(PROFILE_ATTACH_RETRY_TIMEOUT_MS)) {
          return;
        }
      }
      if (remoteCdp && (await isReachable(PROFILE_ATTACH_RETRY_TIMEOUT_MS))) {
        return;
      }
      const detail = await describeCdpFailure(PROFILE_ATTACH_RETRY_TIMEOUT_MS);
      throw new BrowserProfileUnavailableError(
        remoteCdp
          ? `Remote CDP websocket for profile "${profile.name}" is not reachable. ${detail}`
          : `Browser attachOnly is enabled and CDP websocket for profile "${profile.name}" is not reachable. ${detail}`,
      );
    }

    // HTTP responds but WebSocket fails - port in use by something else.
    if (!profileState.running) {
      const detail = await describeCdpFailure(PROFILE_ATTACH_RETRY_TIMEOUT_MS);
      throw new BrowserProfileUnavailableError(
        `Port ${profile.cdpPort} is in use for profile "${profile.name}" but not by openclaw. ` +
          `${formatLocalPortOwnershipHint(profile)} ${detail}`,
      );
    }

    await stopOpenClawChrome(profileState.running);
    setProfileRunning(null);

    const relaunched = await launchManagedChrome(profileState, current, launchOptions);
    attachRunning(relaunched);

    if (!(await isReachable(PROFILE_POST_RESTART_WS_TIMEOUT_MS))) {
      const err = new Error(
        `Chrome CDP websocket for profile "${profile.name}" is not reachable after restart. ${await describeCdpFailure(
          PROFILE_POST_RESTART_WS_TIMEOUT_MS,
        )}`,
      );
      recordManagedLaunchFailure(profileState, err);
      throw err;
    }
    resetManagedLaunchFailure(profileState);
  };

  const ensureBrowserAvailable = async (options?: BrowserEnsureOptions): Promise<void> => {
    const key = ensureOptionsKey(options);
    const profileState = getProfileState();
    for (;;) {
      const current = profileState.ensureBrowserAvailable;
      if (!current) {
        break;
      }
      if (current.key === key) {
        return current.promise;
      }
      await current.promise.catch(() => {});
    }
    const promise = ensureBrowserAvailableOnce(options).finally(() => {
      if (profileState.ensureBrowserAvailable?.promise === promise) {
        profileState.ensureBrowserAvailable = null;
      }
    });
    profileState.ensureBrowserAvailable = { key, promise };
    return promise;
  };

  const stopRunningBrowser = async (): Promise<{ stopped: boolean }> => {
    await reconcileProfileRuntime();
    if (capabilities.usesChromeMcp) {
      const { closeChromeMcpSession } = await getChromeMcpModule();
      const stopped = await closeChromeMcpSession(profile.name);
      return { stopped };
    }
    const profileState = getProfileState();
    resetManagedLaunchFailure(profileState);
    if (!profileState.running) {
      const idleStop = resolveIdleProfileStopOutcome(profile);
      if (idleStop.closePlaywright) {
        // No process was launched for attachOnly/remote profiles, but a cached
        // Playwright CDP connection may still be active and holding emulation state.
        await closePlaywrightBrowserConnectionForProfile(profile.cdpUrl);
      }
      return { stopped: idleStop.stopped };
    }
    await stopOpenClawChrome(profileState.running);
    setProfileRunning(null);
    return { stopped: true };
  };

  return {
    isHttpReachable,
    isTransportAvailable,
    isReachable,
    ensureBrowserAvailable,
    stopRunningBrowser,
  };
}
