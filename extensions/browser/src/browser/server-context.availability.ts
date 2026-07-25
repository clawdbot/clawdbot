/**
 * Browser profile availability operations: reachability probes, managed Chrome
 * launch/restart, Chrome MCP attach, and profile stop handling.
 */
import fs from "node:fs";
import { resolveCdpReachabilityPolicy } from "./cdp-reachability-policy.js";
import {
  CHROME_MCP_ATTACH_READY_POLL_MS,
  CHROME_MCP_ATTACH_READY_WINDOW_MS,
  PROFILE_ATTACH_RETRY_TIMEOUT_MS,
  resolveCdpReachabilityTimeouts,
} from "./cdp-timeouts.js";
import { redactCdpUrl } from "./cdp.helpers.js";
import { getChromeMcpModule } from "./chrome-mcp.runtime.js";
import { diagnoseChromeCdp, formatChromeCdpDiagnostic } from "./chrome.diagnostics.js";
import {
  isChromeCdpOwnedByPid,
  isChromeCdpReady,
  isChromeReachable,
  launchOpenClawChrome,
  ManagedChromeCleanupError,
  stopOpenClawChrome,
} from "./chrome.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { BROWSER_ERROR_REASONS, BrowserProfileUnavailableError } from "./errors.js";
import { getExtensionRelayModule } from "./extension-relay.runtime.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import {
  CDP_READY_AFTER_LAUNCH_MAX_TIMEOUT_MS,
  CDP_READY_AFTER_LAUNCH_MIN_TIMEOUT_MS,
  CDP_READY_AFTER_LAUNCH_POLL_MS,
  CDP_READY_AFTER_LAUNCH_WINDOW_MS,
} from "./server-context.constants.js";
import {
  assertProfileLifecycleContext,
  beginProfileTransition,
  enqueueProfileStart,
  getProfileLifecycle,
  isProfileGenerationCurrent,
  isProfileRestartRequiredError,
  isWithinProfileOperationLease,
  ProfileRestartRequiredError,
  registerProfileHandle,
  releaseProfileHandle,
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
  runtime: ProfileRuntimeState;
  configRevision: number;
};

type AvailabilityOps = {
  isHttpReachable: (timeoutMs?: number, signal?: AbortSignal) => Promise<boolean>;
  isTransportAvailable: (timeoutMs?: number, signal?: AbortSignal) => Promise<boolean>;
  isReachable: (
    timeoutMs?: number,
    options?: { ephemeral?: boolean; signal?: AbortSignal },
  ) => Promise<boolean>;
  ensureBrowserAvailable: (opts?: { headless?: boolean; signal?: AbortSignal }) => Promise<void>;
  stopRunningBrowser: () => Promise<{ stopped: boolean }>;
};

type BrowserEnsureOptions = {
  headless?: boolean;
  signal?: AbortSignal;
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

/** Builds reachability, ensure, and stop operations for one resolved browser profile. */
export function createProfileAvailability({
  opts,
  profile,
  state,
  runtime,
  configRevision,
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
  // Extension profiles probe against the relay server, so it must be listening
  // before any reachability check; starting it reconciles port/token drift and
  // is cheap and idempotent.
  const ensureExtensionRelay = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (capabilities.mode !== "local-extension") {
      return;
    }
    const { ensureExtensionRelayForProfile } = await getExtensionRelayModule();
    const current = state();
    await ensureExtensionRelayForProfile(current, profile);
    signal?.throwIfAborted();
  };
  const isReachable = async (
    timeoutMs?: number,
    options?: { ephemeral?: boolean; signal?: AbortSignal },
  ) => {
    await ensureExtensionRelay(options?.signal);
    if (capabilities.usesChromeMcp) {
      // countChromeMcpTabs creates the session if needed — no separate availability call required.
      // Status probes opt into ephemeral so they reuse a cached attach session if one exists,
      // but do not seed a new persistent session as a side effect of read-only status calls.
      const { countChromeMcpTabs } = await getChromeMcpModule();
      const callOptions: { timeoutMs?: number; ephemeral?: boolean; signal?: AbortSignal } = {};
      if (timeoutMs != null) {
        callOptions.timeoutMs = timeoutMs;
      }
      if (options?.ephemeral) {
        callOptions.ephemeral = true;
      }
      if (options?.signal) {
        callOptions.signal = options.signal;
      }
      await countChromeMcpTabs(profile.name, profile, callOptions);
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

  const isTransportAvailable = async (timeoutMs?: number, signal?: AbortSignal) => {
    if (capabilities.usesChromeMcp) {
      const { ensureChromeMcpAvailable } = await getChromeMcpModule();
      await ensureChromeMcpAvailable(profile.name, profile, {
        ephemeral: true,
        timeoutMs,
        signal,
      });
      return true;
    }
    return await isReachable(timeoutMs, { signal });
  };

  const isHttpReachable = async (timeoutMs?: number, signal?: AbortSignal) => {
    if (capabilities.usesChromeMcp) {
      return await isTransportAvailable(timeoutMs, signal);
    }
    await ensureExtensionRelay(signal);
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

  const stopExactRunning = async (
    profileState: ProfileRuntimeState,
    running: NonNullable<ProfileRuntimeState["running"]>,
  ) => {
    try {
      await stopOpenClawChrome(running);
      releaseProfileHandle(profileState, running);
    } catch (err) {
      getProfileLifecycle(profileState).blockedReason = "managed Chrome cleanup failed";
      throw err;
    }
  };

  const adoptRunning = (params: {
    profileState: ProfileRuntimeState;
    running: NonNullable<ProfileRuntimeState["running"]>;
    generation: number;
    signal: AbortSignal;
  }): void => {
    const actor = getProfileLifecycle(params.profileState);
    if (
      !isProfileGenerationCurrent({
        state: state(),
        runtime: params.profileState,
        configRevision,
        generation: params.generation,
      })
    ) {
      params.signal.throwIfAborted();
      throw new BrowserProfileUnavailableError(
        `Browser start for profile "${profile.name}" was superseded.`,
      );
    }
    if (
      !actor.handles.has(params.running) ||
      params.running.proc.exitCode != null ||
      params.running.proc.signalCode != null
    ) {
      throw new BrowserProfileUnavailableError(
        `Managed Chrome for profile "${profile.name}" exited before adoption.`,
      );
    }
    params.profileState.running = params.running;
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

  const waitForPoll = async (delayMs: number, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Browser availability wait aborted.", { cause: signal.reason }),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
  };

  const waitForCdpReadyAfterLaunch = async (
    signal: AbortSignal,
    running: NonNullable<ProfileRuntimeState["running"]>,
  ): Promise<void> => {
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
      signal.throwIfAborted();
      if (await isReachable(attemptTimeoutMs, { signal })) {
        const ownsEndpoint = await isChromeCdpOwnedByPid(
          profile.cdpUrl,
          running.pid,
          attemptTimeoutMs,
          getCdpReachabilityPolicy(),
        );
        signal.throwIfAborted();
        if (!ownsEndpoint) {
          throw new BrowserProfileUnavailableError(
            `Managed Chrome for profile "${profile.name}" did not own its CDP endpoint.`,
          );
        }
        return;
      }
      await waitForPoll(CDP_READY_AFTER_LAUNCH_POLL_MS, signal);
    }
    throw new Error(
      `Chrome CDP websocket for profile "${profile.name}" is not reachable after start. ${await describeCdpFailure(
        CDP_READY_AFTER_LAUNCH_MAX_TIMEOUT_MS,
      )}`,
    );
  };

  const waitForChromeMcpReadyAfterAttach = async (signal: AbortSignal): Promise<void> => {
    const deadlineMs = Date.now() + CHROME_MCP_ATTACH_READY_WINDOW_MS;
    let lastError: unknown;
    while (Date.now() < deadlineMs) {
      try {
        const { listChromeMcpTabs } = await getChromeMcpModule();
        await listChromeMcpTabs(profile.name, profile, { signal });
        return;
      } catch (err) {
        lastError = err;
      }
      signal.throwIfAborted();
      await waitForPoll(CHROME_MCP_ATTACH_READY_POLL_MS, signal);
    }
    throw new BrowserProfileUnavailableError(formatChromeMcpAttachFailure(lastError));
  };

  const launchManagedChrome = async (
    profileState: ProfileRuntimeState,
    current: BrowserServerState,
    launchOptions: ReturnType<typeof launchOptionsForEnsure>,
    signal: AbortSignal,
  ) => {
    assertManagedLaunchNotCoolingDown(profile.name, profileState);
    try {
      return await launchOpenClawChrome(current.resolved, profile, {
        ...launchOptions,
        signal,
      });
    } catch (err) {
      if (err instanceof ManagedChromeCleanupError) {
        if (registerProfileHandle(profileState, err.running)) {
          getProfileLifecycle(profileState).blockedReason = "managed Chrome cleanup failed";
        }
        throw err;
      }
      if (signal.aborted) {
        throw err;
      }
      // Missing-display rejection happens before a process launch. Do not let
      // repeated headed requests block the explicit headless recovery path.
      if (
        !(
          err instanceof BrowserProfileUnavailableError &&
          err.metadata?.reason === BROWSER_ERROR_REASONS.noDisplayForHeadedProfile
        )
      ) {
        recordManagedLaunchFailure(profileState, err);
      }
      throw err;
    }
  };

  const ensureBrowserAvailableOnce = async (
    signal: AbortSignal,
    generation: number,
    options?: BrowserEnsureOptions,
  ): Promise<void> => {
    signal.throwIfAborted();
    if (capabilities.usesChromeMcp) {
      if (profile.userDataDir && !fs.existsSync(profile.userDataDir)) {
        throw new BrowserProfileUnavailableError(
          `Browser user data directory not found for profile "${profile.name}": ${profile.userDataDir}`,
        );
      }
      const { ensureChromeMcpAvailable } = await getChromeMcpModule();
      await ensureChromeMcpAvailable(profile.name, profile, { signal });
      await waitForChromeMcpReadyAfterAttach(signal);
      return;
    }
    const current = state();
    const remoteCdp = capabilities.isRemote;
    const attachOnly = profile.attachOnly;
    const httpReachable = await isHttpReachable(undefined, signal);
    const launchOptions = launchOptionsForEnsure(options);

    if (!httpReachable) {
      if ((attachOnly || remoteCdp) && opts.onEnsureAttachTarget) {
        await opts.onEnsureAttachTarget(profile);
        signal.throwIfAborted();
        if (await isHttpReachable(PROFILE_ATTACH_RETRY_TIMEOUT_MS, signal)) {
          return;
        }
      }
      // Browser control service can restart while a loopback OpenClaw browser is still
      // alive. Give that pre-existing browser one longer probe window before falling
      // back to local executable resolution.
      if (!attachOnly && !remoteCdp && profile.cdpIsLoopback && !runtime.running) {
        if (
          (await isHttpReachable(PROFILE_ATTACH_RETRY_TIMEOUT_MS, signal)) &&
          (await isReachable(PROFILE_ATTACH_RETRY_TIMEOUT_MS, { signal }))
        ) {
          resetManagedLaunchFailure(runtime);
          return;
        }
      }
      if (attachOnly || remoteCdp) {
        if (capabilities.mode === "local-extension") {
          const { EXTENSION_PAIRING_HINT } = await getExtensionRelayModule();
          throw new BrowserProfileUnavailableError(
            `The OpenClaw Chrome extension is not connected for profile "${profile.name}". ` +
              `Open Chrome on this machine and check the extension popup shows "Connected". ${EXTENSION_PAIRING_HINT}`,
          );
        }
        throw new BrowserProfileUnavailableError(
          remoteCdp
            ? `Remote CDP for profile "${profile.name}" is not reachable at ${redactedProfileCdpUrl}.`
            : `Browser attachOnly is enabled and profile "${profile.name}" is not running.`,
        );
      }
      if (runtime.running) {
        throw new ProfileRestartRequiredError();
      }
      const launched = await launchManagedChrome(runtime, current, launchOptions, signal);
      if (!registerProfileHandle(runtime, launched)) {
        throw new BrowserProfileUnavailableError(
          `Managed Chrome for profile "${profile.name}" exited before adoption.`,
        );
      }
      try {
        await waitForCdpReadyAfterLaunch(signal, launched);
        adoptRunning({ profileState: runtime, running: launched, generation, signal });
        resetManagedLaunchFailure(runtime);
      } catch (err) {
        await stopExactRunning(runtime, launched);
        if (!signal.aborted) {
          recordManagedLaunchFailure(runtime, err);
        }
        throw err;
      }
      return;
    }

    // Port is reachable - check if we own it.
    if (await isReachable(undefined, { signal })) {
      resetManagedLaunchFailure(runtime);
      return;
    }

    // HTTP responds but WebSocket fails. For attachOnly/remote profiles, never perform
    // local ownership/restart handling; just run attach retries and surface attach errors.
    if (attachOnly || remoteCdp) {
      if (opts.onEnsureAttachTarget) {
        await opts.onEnsureAttachTarget(profile);
        signal.throwIfAborted();
        if (await isReachable(PROFILE_ATTACH_RETRY_TIMEOUT_MS, { signal })) {
          return;
        }
      }
      if (remoteCdp && (await isReachable(PROFILE_ATTACH_RETRY_TIMEOUT_MS, { signal }))) {
        return;
      }
      if (capabilities.mode === "local-extension") {
        const { EXTENSION_PAIRING_HINT } = await getExtensionRelayModule();
        throw new BrowserProfileUnavailableError(
          `The extension relay for profile "${profile.name}" is running but the OpenClaw Chrome extension is not connected. ${EXTENSION_PAIRING_HINT}`,
        );
      }
      const detail = await describeCdpFailure(PROFILE_ATTACH_RETRY_TIMEOUT_MS);
      throw new BrowserProfileUnavailableError(
        remoteCdp
          ? `Remote CDP websocket for profile "${profile.name}" is not reachable. ${detail}`
          : `Browser attachOnly is enabled and CDP websocket for profile "${profile.name}" is not reachable. ${detail}`,
      );
    }

    // HTTP responds but WebSocket fails - port in use by something else.
    if (!runtime.running) {
      const detail = await describeCdpFailure(PROFILE_ATTACH_RETRY_TIMEOUT_MS);
      throw new BrowserProfileUnavailableError(
        `Port ${profile.cdpPort} is in use for profile "${profile.name}" but not by openclaw. ` +
          `${formatLocalPortOwnershipHint(profile)} ${detail}`,
      );
    }

    throw new ProfileRestartRequiredError();
  };

  const ensureBrowserAvailable = async (options?: BrowserEnsureOptions): Promise<void> => {
    const key = ensureOptionsKey(options);
    for (;;) {
      try {
        await enqueueProfileStart({
          state: state(),
          runtime,
          configRevision,
          key,
          signal: options?.signal,
          run: async (signal, generation) => {
            await ensureBrowserAvailableOnce(signal, generation, options);
          },
        });
        return;
      } catch (err) {
        if (!isProfileRestartRequiredError(err)) {
          throw err;
        }
        // A route may already hold an ordinary lease. Let its wrapper release
        // and retry so a restart never waits on its own generation lease.
        if (isWithinProfileOperationLease(runtime)) {
          throw err;
        }
        await beginProfileTransition({
          state: state(),
          runtime,
          reason: "managed Chrome restart required",
        });
      }
    }
  };

  const stopRunningBrowser = async (): Promise<{ stopped: boolean }> => {
    assertProfileLifecycleContext({ state: state(), runtime, configRevision });
    resetManagedLaunchFailure(runtime);
    const result = await beginProfileTransition({
      state: state(),
      runtime,
      reason: "stop requested",
    });
    return { stopped: result.stopped || profile.attachOnly || capabilities.isRemote };
  };

  return {
    isHttpReachable,
    isTransportAvailable,
    isReachable,
    ensureBrowserAvailable,
    stopRunningBrowser,
  };
}
