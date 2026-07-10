/**
 * Browser tab selection operations for default tab choice, focus, and close.
 */
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatErrorMessage } from "../infra/errors.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { fetchOk, normalizeCdpHttpBaseForJsonEndpoints } from "./cdp.helpers.js";
import { appendCdpPath } from "./cdp.js";
import { getChromeMcpModule } from "./chrome-mcp.runtime.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { BrowserTabNotFoundError, BrowserTargetAmbiguousError } from "./errors.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import type { PwAiModule } from "./pw-ai-module.js";
import { getPwAiModule } from "./pw-ai-module.js";
import {
  OPEN_TAB_DISCOVERY_POLL_MS,
  OPEN_TAB_DISCOVERY_WINDOW_MS,
} from "./server-context.constants.js";
import type {
  BrowserTab,
  BrowserOperationOptions,
  BrowserTabTargetOptions,
  EnsureTabAvailableOptions,
  ProfileRuntimeState,
} from "./server-context.types.js";
import { resolveTargetIdFromTabs } from "./target-id.js";

type SelectionDeps = {
  profile: ResolvedBrowserProfile;
  getProfileState: () => ProfileRuntimeState;
  getCdpControlPolicy: () => SsrFPolicy | undefined;
  ensureBrowserAvailable: (opts?: { headless?: boolean }) => Promise<void>;
  listTabs: (options?: BrowserOperationOptions) => Promise<BrowserTab[]>;
  openTab: (url: string) => Promise<BrowserTab>;
};

type SelectionOps = {
  ensureTabAvailable: (
    targetId?: string,
    options?: EnsureTabAvailableOptions,
  ) => Promise<BrowserTab>;
  focusTab: (targetId: string, options?: BrowserTabTargetOptions) => Promise<void>;
  closeTab: (targetId: string, options?: BrowserTabTargetOptions) => Promise<void>;
};

function mergeOpenedTabSnapshot(
  tabs: BrowserTab[],
  openedTab: BrowserTab | undefined,
): BrowserTab[] {
  if (!openedTab) {
    return tabs;
  }
  const index = tabs.findIndex((tab) => tab.targetId === openedTab.targetId);
  if (index < 0) {
    return [...tabs, openedTab];
  }
  const listedTab = tabs[index];
  if (!listedTab || listedTab.wsUrl || !openedTab.wsUrl) {
    return tabs;
  }
  const merged = tabs.slice();
  merged[index] = { ...listedTab, wsUrl: openedTab.wsUrl };
  return merged;
}

function waitForTabDiscoveryPoll(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, OPEN_TAB_DISCOVERY_POLL_MS);
  });
}

/** Builds tab selection/focus/close operations for one resolved browser profile. */
export function createProfileSelectionOps({
  profile,
  getProfileState,
  getCdpControlPolicy,
  ensureBrowserAvailable,
  listTabs,
  openTab,
}: SelectionDeps): SelectionOps {
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(profile.cdpUrl);
  const capabilities = getBrowserProfileCapabilities(profile);

  const ensureTabAvailable = async (
    targetId?: string,
    options?: EnsureTabAvailableOptions,
  ): Promise<BrowserTab> => {
    options?.signal?.throwIfAborted();
    await ensureBrowserAvailable();
    options?.signal?.throwIfAborted();
    const profileState = getProfileState();
    let lastNonEmptyTabs: BrowserTab[] = [];
    let lastListError: unknown;
    let sawSuccessfulList = false;
    let openedTab: BrowserTab | undefined;

    const readTabs = async (): Promise<BrowserTab[]> => {
      try {
        const tabs = await listTabs(options);
        sawSuccessfulList = true;
        if (tabs.length > 0) {
          lastNonEmptyTabs = tabs;
        }
        return tabs;
      } catch (err) {
        options?.signal?.throwIfAborted();
        lastListError = err;
        return [];
      }
    };

    const openWhenConfirmedEmpty = async (tabs: BrowserTab[]): Promise<void> => {
      if (!openedTab && sawSuccessfulList && lastNonEmptyTabs.length === 0 && tabs.length === 0) {
        openedTab = await openTab("about:blank");
      }
    };

    const candidateTabs = (tabs: BrowserTab[]) =>
      capabilities.supportsPerTabWs ? tabs.filter((tab) => Boolean(tab.wsUrl)) : tabs;
    const canResolveSelection = (tabs: BrowserTab[]) => {
      const desiredTargetId =
        targetId ??
        openedTab?.targetId ??
        normalizeOptionalString(profileState.lastTargetId) ??
        undefined;
      if (!desiredTargetId) {
        return tabs.length > 0;
      }
      if (targetId === undefined) {
        return tabs.some((tab) => tab.targetId === desiredTargetId);
      }
      const resolved = resolveTargetIdFromTabs(desiredTargetId, tabs);
      return resolved.ok || resolved.reason === "ambiguous";
    };

    const tabs1 = await readTabs();
    await openWhenConfirmedEmpty(tabs1);

    let listedTabs = await readTabs();
    await openWhenConfirmedEmpty(listedTabs);
    let unfilteredTabs = mergeOpenedTabSnapshot(listedTabs, openedTab);
    let candidates = candidateTabs(unfilteredTabs);
    const preservedCanResolveSelection = () =>
      canResolveSelection(mergeOpenedTabSnapshot(lastNonEmptyTabs, openedTab));

    if (
      capabilities.supportsPerTabWs &&
      !canResolveSelection(candidates) &&
      (candidates.length === 0 ||
        canResolveSelection(unfilteredTabs) ||
        preservedCanResolveSelection())
    ) {
      const deadline = Date.now() + OPEN_TAB_DISCOVERY_WINDOW_MS;
      while (Date.now() < deadline) {
        await waitForTabDiscoveryPoll();
        listedTabs = await readTabs();
        await openWhenConfirmedEmpty(listedTabs);
        unfilteredTabs = mergeOpenedTabSnapshot(listedTabs, openedTab);
        candidates = candidateTabs(unfilteredTabs);
        if (canResolveSelection(candidates)) {
          break;
        }
      }
    }

    if (!canResolveSelection(candidates)) {
      // Keep the last useful discovery snapshot across empty or failed relists.
      // Target-id-only fallback is opt-in because only Playwright-backed callers can use it safely.
      const preservedTabs = mergeOpenedTabSnapshot(lastNonEmptyTabs, openedTab);
      const preservedCandidates = candidateTabs(preservedTabs);
      if (canResolveSelection(preservedCandidates)) {
        candidates = preservedCandidates;
      } else if (options?.allowPlaywrightFallback && canResolveSelection(preservedTabs)) {
        candidates = preservedTabs;
      }
    }

    if (candidates.length === 0 && !sawSuccessfulList && lastListError) {
      throw lastListError instanceof Error
        ? lastListError
        : new Error(formatErrorMessage(lastListError));
    }

    const resolveById = (raw: string, targetOptions?: BrowserTabTargetOptions) => {
      if (targetOptions?.exactTargetId) {
        return candidates.find((tab) => tab.targetId === raw) ?? null;
      }
      const resolved = resolveTargetIdFromTabs(raw, candidates);
      if (!resolved.ok) {
        if (resolved.reason === "ambiguous") {
          return "AMBIGUOUS" as const;
        }
        return null;
      }
      return candidates.find((t) => t.targetId === resolved.targetId) ?? null;
    };

    const pickDefault = () => {
      const last = normalizeOptionalString(profileState.lastTargetId) ?? "";
      const lastResolved = last ? resolveById(last, { exactTargetId: true }) : null;
      if (lastResolved && lastResolved !== "AMBIGUOUS") {
        return lastResolved;
      }
      // Prefer a real page tab first (avoid service workers/background targets).
      const page = candidates.find((t) => (t.type ?? "page") === "page");
      return page ?? candidates.at(0) ?? null;
    };

    const chosen = targetId ? resolveById(targetId) : pickDefault();

    if (chosen === "AMBIGUOUS") {
      throw new BrowserTargetAmbiguousError();
    }
    if (!chosen) {
      throw new BrowserTabNotFoundError(targetId ? { input: targetId } : undefined);
    }
    profileState.lastTargetId = chosen.targetId;
    return chosen;
  };

  const resolveTargetIdOrThrow = async (
    targetId: string,
    options?: BrowserTabTargetOptions,
  ): Promise<string> => {
    const tabs = await listTabs();
    if (options?.exactTargetId) {
      const exactTarget = tabs.find((tab) => tab.targetId === targetId);
      if (!exactTarget) {
        throw new BrowserTabNotFoundError({ input: targetId });
      }
      return exactTarget.targetId;
    }
    const resolved = resolveTargetIdFromTabs(targetId, tabs);
    if (!resolved.ok) {
      if (resolved.reason === "ambiguous") {
        throw new BrowserTargetAmbiguousError();
      }
      throw new BrowserTabNotFoundError({ input: targetId });
    }
    return resolved.targetId;
  };

  const focusTab = async (targetId: string, options?: BrowserTabTargetOptions): Promise<void> => {
    const resolvedTargetId = await resolveTargetIdOrThrow(targetId, options);

    if (capabilities.usesChromeMcp) {
      const { focusChromeMcpTab } = await getChromeMcpModule();
      await focusChromeMcpTab(profile.name, resolvedTargetId, profile);
      const profileState = getProfileState();
      profileState.lastTargetId = resolvedTargetId;
      return;
    }

    if (capabilities.usesPersistentPlaywright) {
      const mod = await getPwAiModule({ mode: "strict" });
      const focusPageByTargetIdViaPlaywright = (mod as Partial<PwAiModule> | null)
        ?.focusPageByTargetIdViaPlaywright;
      if (typeof focusPageByTargetIdViaPlaywright === "function") {
        await focusPageByTargetIdViaPlaywright({
          cdpUrl: profile.cdpUrl,
          targetId: resolvedTargetId,
          ssrfPolicy: getCdpControlPolicy(),
        });
        const profileState = getProfileState();
        profileState.lastTargetId = resolvedTargetId;
        return;
      }
    }

    await fetchOk(
      appendCdpPath(cdpHttpBase, `/json/activate/${resolvedTargetId}`),
      undefined,
      undefined,
      getCdpControlPolicy(),
    );
    const profileState = getProfileState();
    profileState.lastTargetId = resolvedTargetId;
  };

  const closeTab = async (targetId: string, options?: BrowserTabTargetOptions): Promise<void> => {
    const resolvedTargetId = await resolveTargetIdOrThrow(targetId, options);

    if (capabilities.usesChromeMcp) {
      const { closeChromeMcpTab } = await getChromeMcpModule();
      await closeChromeMcpTab(profile.name, resolvedTargetId, profile);
      return;
    }

    // For remote profiles, use Playwright's persistent connection to close tabs
    if (capabilities.usesPersistentPlaywright) {
      const mod = await getPwAiModule({ mode: "strict" });
      const closePageByTargetIdViaPlaywright = (mod as Partial<PwAiModule> | null)
        ?.closePageByTargetIdViaPlaywright;
      if (typeof closePageByTargetIdViaPlaywright === "function") {
        await closePageByTargetIdViaPlaywright({
          cdpUrl: profile.cdpUrl,
          targetId: resolvedTargetId,
          ssrfPolicy: getCdpControlPolicy(),
        });
        return;
      }
    }

    await fetchOk(
      appendCdpPath(cdpHttpBase, `/json/close/${resolvedTargetId}`),
      undefined,
      undefined,
      getCdpControlPolicy(),
    );
  };

  return {
    ensureTabAvailable,
    focusTab,
    closeTab,
  };
}
