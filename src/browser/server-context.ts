import fs from "node:fs";

import { createTargetViaCdp, normalizeCdpWsUrl } from "./cdp.js";
import {
  isChromeCdpReady,
  isChromeReachable,
  launchClawdChrome,
  resolveClawdUserDataDir,
  stopClawdChrome,
} from "./chrome.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { resolveProfile } from "./config.js";
import type {
  BrowserRouteContext,
  BrowserTab,
  ContextOptions,
  ProfileContext,
  ProfileRuntimeState,
  ProfileStatus,
} from "./server-context.types.js";
import {
  ensureChromeExtensionRelayServer,
  stopChromeExtensionRelayServer,
} from "./extension-relay.js";
import { resolveTargetIdFromTabs } from "./target-id.js";
import { movePathToTrash } from "./trash.js";

export type {
  BrowserRouteContext,
  BrowserServerState,
  BrowserTab,
  ProfileContext,
  ProfileRuntimeState,
  ProfileStatus,
} from "./server-context.types.js";

/**
 * Normalize a CDP WebSocket URL to use the correct base URL.
 */
function normalizeWsUrl(raw: string | undefined, cdpBaseUrl: string): string | undefined {
  if (!raw) return undefined;
  try {
    return normalizeCdpWsUrl(raw, cdpBaseUrl);
  } catch {
    return raw;
  }
}

async function fetchJson<T>(url: string, timeoutMs = 1500, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

async function fetchOk(url: string, timeoutMs = 1500, init?: RequestInit): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Create a profile-scoped context for browser operations.
 */
function createProfileContext(
  opts: ContextOptions,
  profile: ResolvedBrowserProfile,
): ProfileContext {
  const state = () => {
    const current = opts.getState();
    if (!current) throw new Error("Browser server not started");
    return current;
  };

  const getProfileState = (): ProfileRuntimeState => {
    const current = state();
    let profileState = current.profiles.get(profile.name);
    if (!profileState) {
      profileState = { profile, running: null, lastTargetId: null };
      current.profiles.set(profile.name, profileState);
    }
    return profileState;
  };

  const setProfileRunning = (running: ProfileRuntimeState["running"]) => {
    const profileState = getProfileState();
    profileState.running = running;
  };

  const listTabs = async (): Promise<BrowserTab[]> => {
    const raw = await fetchJson<
      Array<{
        id?: string;
        title?: string;
        url?: string;
        webSocketDebuggerUrl?: string;
        type?: string;
      }>
    >(`${profile.cdpUrl.replace(/\/$/, "")}/json/list`);
    return raw
      .map((t) => ({
        targetId: t.id ?? "",
        title: t.title ?? "",
        url: t.url ?? "",
        wsUrl: normalizeWsUrl(t.webSocketDebuggerUrl, profile.cdpUrl),
        type: t.type,
      }))
      .filter((t) => Boolean(t.targetId));
  };

  const openTab = async (url: string): Promise<BrowserTab> => {
    const createdViaCdp = await createTargetViaCdp({
      cdpUrl: profile.cdpUrl,
      url,
    })
      .then((r) => r.targetId)
      .catch(() => null);

    if (createdViaCdp) {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const tabs = await listTabs().catch(() => [] as BrowserTab[]);
        const found = tabs.find((t) => t.targetId === createdViaCdp);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 100));
      }
      return { targetId: createdViaCdp, title: "", url, type: "page" };
    }

    const encoded = encodeURIComponent(url);
    type CdpTarget = {
      id?: string;
      title?: string;
      url?: string;
      webSocketDebuggerUrl?: string;
      type?: string;
    };

    const base = profile.cdpUrl.replace(/\/$/, "");
    const endpoint = `${base}/json/new?${encoded}`;
    const created = await fetchJson<CdpTarget>(endpoint, 1500, {
      method: "PUT",
    }).catch(async (err) => {
      if (String(err).includes("HTTP 405")) {
        return await fetchJson<CdpTarget>(endpoint, 1500);
      }
      throw err;
    });

    if (!created.id) throw new Error("Failed to open tab (missing id)");
    const profileState = getProfileState();
    profileState.lastTargetId = created.id;
    return {
      targetId: created.id,
      title: created.title ?? "",
      url: created.url ?? url,
      wsUrl: normalizeWsUrl(created.webSocketDebuggerUrl, base),
      type: created.type,
    };
  };

  const isReachable = async (timeoutMs = 300) => {
    const wsTimeout = Math.max(200, Math.min(2000, timeoutMs * 2));
    return await isChromeCdpReady(profile.cdpUrl, timeoutMs, wsTimeout);
  };

  const isHttpReachable = async (timeoutMs = 300) => {
    return await isChromeReachable(profile.cdpUrl, timeoutMs);
  };

  const attachRunning = (running: NonNullable<ProfileRuntimeState["running"]>) => {
    setProfileRunning(running);
    running.proc.on("exit", () => {
      // Guard against server teardown (e.g., SIGUSR1 restart)
      if (!opts.getState()) return;
      const profileState = getProfileState();
      if (profileState.running?.pid === running.pid) {
        setProfileRunning(null);
      }
    });
  };

  const ensureBrowserAvailable = async (): Promise<void> => {
    const current = state();
    const remoteCdp = !profile.cdpIsLoopback;
    const isExtension = profile.driver === "extension";
    const profileState = getProfileState();
    const httpReachable = await isHttpReachable();

    if (isExtension && remoteCdp) {
      throw new Error(
        `Profile "${profile.name}" uses driver=extension but cdpUrl is not loopback (${profile.cdpUrl}).`,
      );
    }

    if (isExtension) {
      if (!httpReachable) {
        await ensureChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl });
        if (await isHttpReachable(1200)) {
          // continue: we still need the extension to connect for CDP websocket.
        } else {
          throw new Error(
            `Chrome extension relay for profile "${profile.name}" is not reachable at ${profile.cdpUrl}.`,
          );
        }
      }

      if (await isReachable(600)) return;
      // Relay server is up, but no attached tab yet. Prompt user to attach.
      throw new Error(
        `Chrome extension relay is running, but no tab is connected. Click the Clawdbot Chrome extension icon on a tab to attach it (profile "${profile.name}").`,
      );
    }

    if (!httpReachable) {
      if ((current.resolved.attachOnly || remoteCdp) && opts.onEnsureAttachTarget) {
        await opts.onEnsureAttachTarget(profile);
        if (await isHttpReachable(1200)) return;
      }
      if (current.resolved.attachOnly || remoteCdp) {
        throw new Error(
          remoteCdp
            ? `Remote CDP for profile "${profile.name}" is not reachable at ${profile.cdpUrl}.`
            : `Browser attachOnly is enabled and profile "${profile.name}" is not running.`,
        );
      }
      const launched = await launchClawdChrome(current.resolved, profile);
      attachRunning(launched);
      return;
    }

    // Port is reachable - check if we own it
    if (await isReachable()) return;

    // HTTP responds but WebSocket fails - port in use by something else
    if (!profileState.running) {
      throw new Error(
        `Port ${profile.cdpPort} is in use for profile "${profile.name}" but not by clawdbot. ` +
          `Run action=reset-profile profile=${profile.name} to kill the process.`,
      );
    }

    // We own it but WebSocket failed - restart
    if (current.resolved.attachOnly || remoteCdp) {
      if (opts.onEnsureAttachTarget) {
        await opts.onEnsureAttachTarget(profile);
        if (await isReachable(1200)) return;
      }
      throw new Error(
        remoteCdp
          ? `Remote CDP websocket for profile "${profile.name}" is not reachable.`
          : `Browser attachOnly is enabled and CDP websocket for profile "${profile.name}" is not reachable.`,
      );
    }

    await stopClawdChrome(profileState.running);
    setProfileRunning(null);

    const relaunched = await launchClawdChrome(current.resolved, profile);
    attachRunning(relaunched);

    if (!(await isReachable(600))) {
      throw new Error(
        `Chrome CDP websocket for profile "${profile.name}" is not reachable after restart.`,
      );
    }
  };

  const ensureTabAvailable = async (targetId?: string): Promise<BrowserTab> => {
    await ensureBrowserAvailable();
    const profileState = getProfileState();
    const tabs1 = await listTabs();
    if (tabs1.length === 0) {
      if (profile.driver === "extension") {
        throw new Error(
          `tab not found (no attached Chrome tabs for profile "${profile.name}"). ` +
            "Click the Clawdbot Browser Relay toolbar icon on the tab you want to control (badge ON).",
        );
      }
      await openTab("about:blank");
    }

    const tabs = await listTabs();
    const candidates = profile.driver === "extension" ? tabs : tabs.filter((t) => Boolean(t.wsUrl));

    const resolveById = (raw: string) => {
      const resolved = resolveTargetIdFromTabs(raw, candidates);
      if (!resolved.ok) {
        if (resolved.reason === "ambiguous") return "AMBIGUOUS" as const;
        return null;
      }
      return candidates.find((t) => t.targetId === resolved.targetId) ?? null;
    };

    const pickDefault = () => {
      const last = profileState.lastTargetId?.trim() || "";
      const lastResolved = last ? resolveById(last) : null;
      if (lastResolved && lastResolved !== "AMBIGUOUS") return lastResolved;
      // Prefer a real page tab first (avoid service workers/background targets).
      const page = candidates.find((t) => (t.type ?? "page") === "page");
      return page ?? candidates.at(0) ?? null;
    };

    let chosen = targetId ? resolveById(targetId) : pickDefault();
    if (!chosen && profile.driver === "extension" && candidates.length === 1) {
      // If an agent passes a stale/foreign targetId but we only have a single attached tab,
      // recover by using that tab instead of failing hard.
      chosen = candidates[0] ?? null;
    }

    if (chosen === "AMBIGUOUS") {
      throw new Error("ambiguous target id prefix");
    }
    if (!chosen) throw new Error("tab not found");
    profileState.lastTargetId = chosen.targetId;
    return chosen;
  };

  const focusTab = async (targetId: string): Promise<void> => {
    const base = profile.cdpUrl.replace(/\/$/, "");
    const tabs = await listTabs();
    const resolved = resolveTargetIdFromTabs(targetId, tabs);
    if (!resolved.ok) {
      if (resolved.reason === "ambiguous") {
        throw new Error("ambiguous target id prefix");
      }
      throw new Error("tab not found");
    }
    await fetchOk(`${base}/json/activate/${resolved.targetId}`);
    const profileState = getProfileState();
    profileState.lastTargetId = resolved.targetId;
  };

  const closeTab = async (targetId: string): Promise<void> => {
    const base = profile.cdpUrl.replace(/\/$/, "");
    const tabs = await listTabs();
    const resolved = resolveTargetIdFromTabs(targetId, tabs);
    if (!resolved.ok) {
      if (resolved.reason === "ambiguous") {
        throw new Error("ambiguous target id prefix");
      }
      throw new Error("tab not found");
    }
    await fetchOk(`${base}/json/close/${resolved.targetId}`);
  };

  const stopRunningBrowser = async (): Promise<{ stopped: boolean }> => {
    if (profile.driver === "extension") {
      const stopped = await stopChromeExtensionRelayServer({
        cdpUrl: profile.cdpUrl,
      });
      return { stopped };
    }
    const profileState = getProfileState();
    if (!profileState.running) return { stopped: false };
    await stopClawdChrome(profileState.running);
    setProfileRunning(null);
    return { stopped: true };
  };

  const resetProfile = async () => {
    if (profile.driver === "extension") {
      await stopChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl }).catch(() => {});
      return { moved: false, from: profile.cdpUrl };
    }
    if (!profile.cdpIsLoopback) {
      throw new Error(
        `reset-profile is only supported for local profiles (profile "${profile.name}" is remote).`,
      );
    }
    const userDataDir = resolveClawdUserDataDir(profile.name);
    const profileState = getProfileState();

    const httpReachable = await isHttpReachable(300);
    if (httpReachable && !profileState.running) {
      // Port in use but not by us - kill it
      try {
        const mod = await import("./pw-ai.js");
        await mod.closePlaywrightBrowserConnection();
      } catch {
        // ignore
      }
    }

    if (profileState.running) {
      await stopRunningBrowser();
    }

    try {
      const mod = await import("./pw-ai.js");
      await mod.closePlaywrightBrowserConnection();
    } catch {
      // ignore
    }

    if (!fs.existsSync(userDataDir)) {
      return { moved: false, from: userDataDir };
    }

    const moved = await movePathToTrash(userDataDir);
    return { moved: true, from: userDataDir, to: moved };
  };

  return {
    profile,
    ensureBrowserAvailable,
    ensureTabAvailable,
    isHttpReachable,
    isReachable,
    listTabs,
    openTab,
    focusTab,
    closeTab,
    stopRunningBrowser,
    resetProfile,
  };
}

export function createBrowserRouteContext(opts: ContextOptions): BrowserRouteContext {
  const state = () => {
    const current = opts.getState();
    if (!current) throw new Error("Browser server not started");
    return current;
  };

  const forProfile = (profileName?: string): ProfileContext => {
    const current = state();
    const name = profileName ?? current.resolved.defaultProfile;
    const profile = resolveProfile(current.resolved, name);
    if (!profile) {
      const available = Object.keys(current.resolved.profiles).join(", ");
      throw new Error(`Profile "${name}" not found. Available profiles: ${available || "(none)"}`);
    }
    return createProfileContext(opts, profile);
  };

  const listProfiles = async (): Promise<ProfileStatus[]> => {
    const current = state();
    const result: ProfileStatus[] = [];

    for (const name of Object.keys(current.resolved.profiles)) {
      const profileState = current.profiles.get(name);
      const profile = resolveProfile(current.resolved, name);
      if (!profile) continue;

      let tabCount = 0;
      let running = false;

      if (profileState?.running) {
        running = true;
        try {
          const ctx = createProfileContext(opts, profile);
          const tabs = await ctx.listTabs();
          tabCount = tabs.filter((t) => t.type === "page").length;
        } catch {
          // Browser might not be responsive
        }
      } else {
        // Check if something is listening on the port
        try {
          const reachable = await isChromeReachable(profile.cdpUrl, 200);
          if (reachable) {
            running = true;
            const ctx = createProfileContext(opts, profile);
            const tabs = await ctx.listTabs().catch(() => []);
            tabCount = tabs.filter((t) => t.type === "page").length;
          }
        } catch {
          // Not reachable
        }
      }

      result.push({
        name,
        cdpPort: profile.cdpPort,
        cdpUrl: profile.cdpUrl,
        color: profile.color,
        running,
        tabCount,
        isDefault: name === current.resolved.defaultProfile,
        isRemote: !profile.cdpIsLoopback,
      });
    }

    return result;
  };

  // Create default profile context for backward compatibility
  const getDefaultContext = () => forProfile();

  const mapTabError = (err: unknown) => {
    const msg = String(err);
    if (msg.includes("ambiguous target id prefix")) {
      return { status: 409, message: "ambiguous target id prefix" };
    }
    if (msg.includes("tab not found")) {
      return { status: 404, message: msg };
    }
    if (msg.includes("not found")) {
      return { status: 404, message: msg };
    }
    return null;
  };

  return {
    state,
    forProfile,
    listProfiles,
    // Legacy methods delegate to default profile
    ensureBrowserAvailable: () => getDefaultContext().ensureBrowserAvailable(),
    ensureTabAvailable: (targetId) => getDefaultContext().ensureTabAvailable(targetId),
    isHttpReachable: (timeoutMs) => getDefaultContext().isHttpReachable(timeoutMs),
    isReachable: (timeoutMs) => getDefaultContext().isReachable(timeoutMs),
    listTabs: () => getDefaultContext().listTabs(),
    openTab: (url) => getDefaultContext().openTab(url),
    focusTab: (targetId) => getDefaultContext().focusTab(targetId),
    closeTab: (targetId) => getDefaultContext().closeTab(targetId),
    stopRunningBrowser: () => getDefaultContext().stopRunningBrowser(),
    resetProfile: () => getDefaultContext().resetProfile(),
    mapTabError,
  };
}
