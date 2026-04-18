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
import {
  closeChromeMcpSession,
  ensureChromeMcpAvailable,
  listChromeMcpTabs,
} from "./chrome-mcp.js";
import {
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
  isReachable: (timeoutMs?: number) => Promise<boolean>;
  ensureBrowserAvailable: () => Promise<void>;
  stopRunningBrowser: () => Promise<{ stopped: boolean }>;
};

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
      await listChromeMcpTabs(profile.name, profile.userDataDir);
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

  const isHttpReachable = async (timeoutMs?: number) => {
    if (capabilities.usesChromeMcp) {
      return await isReachable(timeoutMs);
    }
    const { httpTimeoutMs } = resolveTimeouts(timeoutMs);
    return await isChromeReachable(profile.cdpUrl, httpTimeoutMs, getCdpReachabilityPolicy());
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

  const reconcileProfileRuntime = async (): Promise<void> => {
    const profileState = getProfileState();
    const reconcile = profileState.reconcile;
    if (!reconcile) {
      return;
    }
    profileState.reconcile = null;
    profileState.lastTargetId = null;

    const previousProfile = reconcile.previousProfile;
    if (profileState.running) {
      await stopOpenClawChrome(profileState.running).catch(() => {});
      setProfileRunning(null);
    }
    if (getBrowserProfileCapabilities(previousProfile).usesChromeMcp) {
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
    const deadlineMs = Date.now() + CDP_READY_AFTER_LAUNCH_WINDOW_MS;
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
      `Chrome CDP websocket for profile "${profile.name}" is not reachable after start.`,
    );
  };

  const waitForChromeMcpReadyAfterAttach = async (): Promise<void> => {
    const deadlineMs = Date.now() + CHROME_MCP_ATTACH_READY_WINDOW_MS;
    let lastError: unknown;
    while (Date.now() < deadlineMs) {
      try {
        await listChromeMcpTabs(profile.name, profile.userDataDir);
        return;
      } catch (err) {
        lastError = err;
      }
      await new Promise((r) => setTimeout(r, CHROME_MCP_ATTACH_READY_POLL_MS));
    }
    const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
    throw new BrowserProfileUnavailableError(
      `Chrome MCP existing-session attach for profile "${profile.name}" timed out waiting for tabs to become available.` +
        ` Approve the browser attach prompt, keep the browser open, and retry.${detail}`,
    );
  };

  const ensureBrowserAvailable = async (): Promise<void> => {
    await reconcileProfileRuntime();
    if (capabilities.usesChromeMcp) {
      if (profile.userDataDir && !fs.existsSync(profile.userDataDir)) {
        throw new BrowserProfileUnavailableError(
          `Browser user data directory not found for profile "${profile.name}": ${profile.userDataDir}`,
        );
      }
      await ensureChromeMcpAvailable(profile.name, profile.userDataDir);
      await waitForChromeMcpReadyAfterAttach();
      return;
    }
    const current = state();
    const remoteCdp = capabilities.isRemote;
    const attachOnly = profile.attachOnly;
    const profileState = getProfileState();
    const httpReachable = await isHttpReachable();

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
      const launched = await launchOpenClawChrome(current.resolved, profile);
      attachRunning(launched);
      try {
        await waitForCdpReadyAfterLaunch();
      } catch (err) {
        await stopOpenClawChrome(launched).catch(() => {});
        setProfileRunning(null);
        throw err;
      }
      return;
    }

    // Port is reachable - check if we own it.
    if (await isReachable()) {
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
      throw new BrowserProfileUnavailableError(
        remoteCdp
          ? `Remote CDP websocket for profile "${profile.name}" is not reachable.`
          : `Browser attachOnly is enabled and CDP websocket for profile "${profile.name}" is not reachable.`,
      );
    }

    // HTTP responds but WebSocket fails - port in use by something else.
    if (!profileState.running) {
      throw new BrowserProfileUnavailableError(
        `Port ${profile.cdpPort} is in use for profile "${profile.name}" but not by openclaw. ` +
          `Run action=reset-profile profile=${profile.name} to kill the process.`,
      );
    }

    await stopOpenClawChrome(profileState.running);
    setProfileRunning(null);

    const relaunched = await launchOpenClawChrome(current.resolved, profile);
    attachRunning(relaunched);

    if (!(await isReachable(PROFILE_POST_RESTART_WS_TIMEOUT_MS))) {
      throw new Error(
        `Chrome CDP websocket for profile "${profile.name}" is not reachable after restart.`,
      );
    }
  };

  const stopRunningBrowser = async (): Promise<{ stopped: boolean }> => {
    await reconcileProfileRuntime();
    if (capabilities.usesChromeMcp) {
      const stopped = await closeChromeMcpSession(profile.name);
      return { stopped };
    }
    const profileState = getProfileState();
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
    isReachable,
    ensureBrowserAvailable,
    stopRunningBrowser,
  };
}
