/**
 * Browser tab listing, opening, labeling, and alias management for one profile.
 */
import { resolveBrowserNavigationProxyMode } from "./browser-proxy-mode.js";
import { resolveCdpControlPolicy } from "./cdp-reachability-policy.js";
import { isSelectableCdpBrowserTarget } from "./cdp-target-filter.js";
import { CDP_JSON_NEW_TIMEOUT_MS } from "./cdp-timeouts.js";
import {
  assertCdpEndpointAllowed,
  fetchJson,
  fetchOk,
  normalizeCdpHttpBaseForJsonEndpoints,
} from "./cdp.helpers.js";
import { appendCdpPath, createTargetViaCdp, normalizeCdpWsUrl } from "./cdp.js";
import type { CdpActionTimeouts } from "./cdp.js";
import { getChromeMcpModule } from "./chrome-mcp.runtime.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { BrowserTabNotFoundError, BrowserTargetAmbiguousError } from "./errors.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
  InvalidBrowserNavigationUrlError,
  requiresInspectableBrowserNavigationRedirectsForUrl,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import type { PwAiModule } from "./pw-ai-module.js";
import { getPwAiModule } from "./pw-ai-module.js";
import {
  MANAGED_BROWSER_PAGE_TAB_LIMIT,
  OPEN_TAB_DISCOVERY_POLL_MS,
  OPEN_TAB_DISCOVERY_WINDOW_MS,
} from "./server-context.constants.js";
import type {
  BrowserOperationOptions,
  BrowserServerState,
  BrowserTab,
  ProfileRuntimeState,
} from "./server-context.types.js";
import { resolveTargetIdFromTabs } from "./target-id.js";

type TabOpsDeps = {
  profile: ResolvedBrowserProfile;
  state: () => BrowserServerState;
  getProfileState: () => ProfileRuntimeState;
};

type ProfileTabOps = {
  listTabs: (options?: BrowserOperationOptions) => Promise<BrowserTab[]>;
  openTab: (url: string, opts?: { label?: string }) => Promise<BrowserTab>;
  labelTab: (targetId: string, label: string) => Promise<BrowserTab>;
};

/**
 * Normalize a CDP WebSocket URL to use the correct base URL.
 */
function normalizeWsUrl(raw: string | undefined, cdpBaseUrl: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return normalizeCdpWsUrl(raw, cdpBaseUrl);
  } catch {
    return raw;
  }
}

type CdpTarget = {
  id?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  type?: string;
};

const TAB_LABEL_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

function normalizeTabLabel(label: string): string {
  const trimmed = label.trim();
  if (!TAB_LABEL_PATTERN.test(trimmed)) {
    throw new Error("tab label must be 1-64 chars and use only letters, numbers, _, ., :, or -");
  }
  return trimmed;
}

function getTabAliasState(
  profileState: ProfileRuntimeState,
): NonNullable<ProfileRuntimeState["tabAliases"]> {
  profileState.tabAliases ??= { nextTabNumber: 1, byTargetId: {} };
  return profileState.tabAliases;
}

function assignTabAlias(params: {
  profileState: ProfileRuntimeState;
  tab: BrowserTab;
  label?: string;
}): BrowserTab {
  const aliases = getTabAliasState(params.profileState);
  let entry = aliases.byTargetId[params.tab.targetId];
  if (!entry) {
    entry = { tabId: `t${aliases.nextTabNumber}` };
    aliases.nextTabNumber += 1;
    aliases.byTargetId[params.tab.targetId] = entry;
  }
  if (params.label) {
    const label = normalizeTabLabel(params.label);
    for (const [targetId, current] of Object.entries(aliases.byTargetId)) {
      if (targetId !== params.tab.targetId && current.label === label) {
        delete current.label;
      }
    }
    entry.label = label;
  }
  entry.url = params.tab.url;
  const labelFields = entry.label ? { label: entry.label } : {};
  return {
    ...params.tab,
    suggestedTargetId: entry.label ?? entry.tabId,
    tabId: entry.tabId,
    ...labelFields,
  };
}

type TabAliasEntry = NonNullable<ProfileRuntimeState["tabAliases"]>["byTargetId"][string];

function normalizeReplacementUrl(url: string | undefined): string | undefined {
  return url?.trim() || undefined;
}

function findConfidentReplacement(params: {
  staleEntry: TabAliasEntry;
  staleEntries: Array<[targetId: string, entry: TabAliasEntry]>;
  newCandidates: BrowserTab[];
}): BrowserTab | undefined {
  const { staleEntry, staleEntries, newCandidates } = params;
  // Preserve shipped form-submit continuity when the replacement set is one-for-one.
  if (staleEntries.length === 1 && newCandidates.length === 1) {
    return newCandidates[0];
  }

  const url = normalizeReplacementUrl(staleEntry.url);
  if (!url) {
    return undefined;
  }
  const staleMatches = staleEntries.filter(
    ([, entry]) => normalizeReplacementUrl(entry.url) === url,
  );
  const candidates = newCandidates.filter((tab) => normalizeReplacementUrl(tab.url) === url);
  // Duplicate URL buckets have no ordering contract, so only migrate an exact 1:1 bucket.
  return staleMatches.length === 1 && candidates.length === 1 ? candidates[0] : undefined;
}

function assignTabAliases(
  profileState: ProfileRuntimeState,
  tabs: BrowserTab[],
  migrateReplacements: boolean,
): BrowserTab[] {
  const aliases = getTabAliasState(profileState);
  const liveTargetIds = new Set(tabs.map((tab) => tab.targetId));
  const staleEntries = Object.entries(aliases.byTargetId).filter(
    ([targetId]) => !liveTargetIds.has(targetId),
  );
  const newCandidates = tabs.filter((tab) => !aliases.byTargetId[tab.targetId]);
  if (migrateReplacements) {
    for (const [oldTargetId, staleEntry] of staleEntries) {
      const candidate = findConfidentReplacement({ staleEntry, staleEntries, newCandidates });
      if (!candidate) {
        continue;
      }
      aliases.byTargetId[candidate.targetId] = staleEntry;
      delete aliases.byTargetId[oldTargetId];
      if (profileState.lastTargetId === oldTargetId) {
        profileState.lastTargetId = candidate.targetId;
      }
    }
  }

  for (const targetId of Object.keys(aliases.byTargetId)) {
    if (!liveTargetIds.has(targetId)) {
      delete aliases.byTargetId[targetId];
    }
  }
  return tabs.map((tab) => assignTabAlias({ profileState, tab }));
}

/** Builds list/open/label tab operations for one resolved browser profile. */
export function createProfileTabOps({
  profile,
  state,
  getProfileState,
}: TabOpsDeps): ProfileTabOps {
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(profile.cdpUrl);
  const capabilities = getBrowserProfileCapabilities(profile);
  const getCdpControlPolicy = () => resolveCdpControlPolicy(profile, state().resolved.ssrfPolicy);
  const getNavigationPolicy = () =>
    withBrowserNavigationPolicy(state().resolved.ssrfPolicy, {
      browserProxyMode: resolveBrowserNavigationProxyMode({
        resolved: state().resolved,
        profile,
      }),
    });
  const getRemoteCdpActionTimeouts = (): CdpActionTimeouts | undefined => {
    if (profile.cdpIsLoopback && !profile.attachOnly) {
      return undefined;
    }
    const resolved = state().resolved;
    return {
      httpTimeoutMs: resolved.remoteCdpTimeoutMs,
      handshakeTimeoutMs: resolved.remoteCdpHandshakeTimeoutMs,
    };
  };

  const readTabs = async (options?: BrowserOperationOptions): Promise<BrowserTab[]> => {
    if (capabilities.usesChromeMcp) {
      const { listChromeMcpTabs } = await getChromeMcpModule();
      return await listChromeMcpTabs(profile.name, profile, options);
    }

    if (capabilities.usesPersistentPlaywright) {
      const mod = await getPwAiModule({ mode: "strict" });
      const listPagesViaPlaywright = (mod as Partial<PwAiModule> | null)?.listPagesViaPlaywright;
      if (typeof listPagesViaPlaywright === "function") {
        const ssrfPolicy = getCdpControlPolicy();
        const resolved = state().resolved;
        const timeoutMs = Math.max(
          resolved.remoteCdpTimeoutMs,
          resolved.remoteCdpHandshakeTimeoutMs,
        );
        await assertCdpEndpointAllowed(profile.cdpUrl, ssrfPolicy);
        const pages = await listPagesViaPlaywright({
          cdpUrl: profile.cdpUrl,
          ssrfPolicy,
          timeoutMs,
        });
        return pages.filter(isSelectableCdpBrowserTarget).map((p) => ({
          targetId: p.targetId,
          title: p.title,
          url: p.url,
          type: p.type,
        }));
      }
    }

    const raw = await fetchJson<
      Array<{
        id?: string;
        title?: string;
        url?: string;
        webSocketDebuggerUrl?: string;
        type?: string;
      }>
    >(appendCdpPath(cdpHttpBase, "/json/list"), undefined, undefined, getCdpControlPolicy());
    const cdpControlPolicy = getCdpControlPolicy();
    const tabs: BrowserTab[] = [];
    for (const t of raw) {
      const tab: BrowserTab = {
        targetId: t.id ?? "",
        title: t.title ?? "",
        url: t.url ?? "",
        wsUrl: normalizeWsUrl(t.webSocketDebuggerUrl, profile.cdpUrl),
        type: t.type,
      };
      if (!tab.targetId || !isSelectableCdpBrowserTarget(tab)) {
        continue;
      }
      if (tab.wsUrl) {
        await assertCdpEndpointAllowed(tab.wsUrl, cdpControlPolicy, {
          source: "discovered",
          configuredUrl: profile.cdpUrl,
        });
      }
      tabs.push(tab);
    }
    return tabs;
  };

  const listTabs = async (options?: BrowserOperationOptions): Promise<BrowserTab[]> => {
    const tabs = await readTabs(options);
    // Chrome MCP target identity is authoritative. A replacement tab cannot
    // inherit an alias safely, even when its URL matches the closed tab.
    return assignTabAliases(getProfileState(), tabs, !capabilities.usesChromeMcp);
  };

  const enforceManagedTabLimit = async (keepTargetId: string): Promise<void> => {
    const profileState = getProfileState();
    if (
      !capabilities.supportsManagedTabLimit ||
      state().resolved.attachOnly ||
      !profileState.running
    ) {
      return;
    }

    const pageTabs = await listTabs()
      .then((tabs) => tabs.filter((tab) => (tab.type ?? "page") === "page"))
      .catch(() => [] as BrowserTab[]);
    if (pageTabs.length <= MANAGED_BROWSER_PAGE_TAB_LIMIT) {
      return;
    }

    const candidates = pageTabs.filter((tab) => tab.targetId !== keepTargetId);
    const excessCount = pageTabs.length - MANAGED_BROWSER_PAGE_TAB_LIMIT;
    for (const tab of candidates.slice(0, excessCount)) {
      void fetchOk(
        appendCdpPath(cdpHttpBase, `/json/close/${tab.targetId}`),
        undefined,
        undefined,
        getCdpControlPolicy(),
      ).catch(() => {
        // best-effort cleanup only
      });
    }
  };

  const triggerManagedTabLimit = (keepTargetId: string): void => {
    void enforceManagedTabLimit(keepTargetId).catch(() => {
      // best-effort cleanup only
    });
  };

  const openTab = async (url: string, opts?: { label?: string }): Promise<BrowserTab> => {
    const ssrfPolicyOpts = getNavigationPolicy();

    if (capabilities.usesChromeMcp) {
      await assertBrowserNavigationAllowed({ url, ...ssrfPolicyOpts });
      const { openChromeMcpTab } = await getChromeMcpModule();
      const page = await openChromeMcpTab(profile.name, url, profile);
      const profileState = getProfileState();
      profileState.lastTargetId = page.targetId;
      await assertBrowserNavigationResultAllowed({ url: page.url, ...ssrfPolicyOpts });
      return assignTabAlias({ profileState, tab: page, label: opts?.label });
    }

    if (capabilities.usesPersistentPlaywright) {
      const mod = await getPwAiModule({ mode: "strict" });
      const createPageViaPlaywright = (mod as Partial<PwAiModule> | null)?.createPageViaPlaywright;
      if (typeof createPageViaPlaywright === "function") {
        const page = await createPageViaPlaywright({
          cdpUrl: profile.cdpUrl,
          url,
          cdpPolicy: getCdpControlPolicy(),
          ...ssrfPolicyOpts,
        });
        const profileState = getProfileState();
        profileState.lastTargetId = page.targetId;
        triggerManagedTabLimit(page.targetId);
        return assignTabAlias({
          profileState,
          label: opts?.label,
          tab: {
            targetId: page.targetId,
            title: page.title,
            url: page.url,
            type: page.type,
          },
        });
      }
    }

    if (requiresInspectableBrowserNavigationRedirectsForUrl(url, state().resolved.ssrfPolicy)) {
      throw new InvalidBrowserNavigationUrlError(
        "Navigation blocked: strict browser SSRF policy requires Playwright-backed redirect-hop inspection",
      );
    }

    await assertBrowserNavigationAllowed({ url, ...ssrfPolicyOpts });
    const cdpActionTimeouts = getRemoteCdpActionTimeouts();
    const createTargetOpts: Parameters<typeof createTargetViaCdp>[0] = {
      cdpUrl: profile.cdpUrl,
      url,
      ssrfPolicy: getCdpControlPolicy(),
    };
    if (cdpActionTimeouts) {
      createTargetOpts.timeouts = cdpActionTimeouts;
    }
    const createdViaCdp = await createTargetViaCdp(createTargetOpts)
      .then((r) => r.targetId)
      .catch(() => null);

    if (createdViaCdp) {
      const profileState = getProfileState();
      profileState.lastTargetId = createdViaCdp;
      const deadline = Date.now() + OPEN_TAB_DISCOVERY_WINDOW_MS;
      while (Date.now() < deadline) {
        const tabs = await listTabs().catch(() => [] as BrowserTab[]);
        const found = tabs.find((t) => t.targetId === createdViaCdp);
        if (found) {
          await assertBrowserNavigationResultAllowed({ url: found.url, ...ssrfPolicyOpts });
          triggerManagedTabLimit(found.targetId);
          return assignTabAlias({ profileState, tab: found, label: opts?.label });
        }
        await new Promise((r) => {
          setTimeout(r, OPEN_TAB_DISCOVERY_POLL_MS);
        });
      }
      triggerManagedTabLimit(createdViaCdp);
      return assignTabAlias({
        profileState,
        tab: { targetId: createdViaCdp, title: "", url, type: "page" },
        label: opts?.label,
      });
    }

    const encoded = encodeURIComponent(url);
    const endpointUrl = new URL(appendCdpPath(cdpHttpBase, "/json/new"));
    const endpoint = endpointUrl.search
      ? (() => {
          endpointUrl.searchParams.set("url", url);
          return endpointUrl.toString();
        })()
      : `${endpointUrl.toString()}?${encoded}`;
    const created = await fetchJson<CdpTarget>(
      endpoint,
      cdpActionTimeouts?.httpTimeoutMs ?? CDP_JSON_NEW_TIMEOUT_MS,
      {
        method: "PUT",
      },
      getCdpControlPolicy(),
    ).catch(async (err: unknown) => {
      if (String(err).includes("HTTP 405")) {
        return await fetchJson<CdpTarget>(
          endpoint,
          cdpActionTimeouts?.httpTimeoutMs ?? CDP_JSON_NEW_TIMEOUT_MS,
          undefined,
          getCdpControlPolicy(),
        );
      }
      throw err;
    });

    if (!created.id) {
      throw new Error("Failed to open tab (missing id)");
    }
    const profileState = getProfileState();
    profileState.lastTargetId = created.id;
    const resolvedUrl = created.url ?? url;
    await assertBrowserNavigationResultAllowed({ url: resolvedUrl, ...ssrfPolicyOpts });
    const wsUrl = normalizeWsUrl(created.webSocketDebuggerUrl, profile.cdpUrl);
    if (wsUrl) {
      await assertCdpEndpointAllowed(wsUrl, getCdpControlPolicy(), {
        source: "discovered",
        configuredUrl: profile.cdpUrl,
      });
    }
    triggerManagedTabLimit(created.id);
    return assignTabAlias({
      profileState,
      label: opts?.label,
      tab: {
        targetId: created.id,
        title: created.title ?? "",
        url: resolvedUrl,
        wsUrl,
        type: created.type,
      },
    });
  };

  const labelTab = async (targetId: string, label: string): Promise<BrowserTab> => {
    const normalizedLabel = normalizeTabLabel(label);
    const tabs = await listTabs();
    const resolved = resolveTargetIdFromTabs(targetId, tabs);
    if (!resolved.ok) {
      if (resolved.reason === "ambiguous") {
        throw new BrowserTargetAmbiguousError();
      }
      throw new BrowserTabNotFoundError({ input: targetId });
    }
    const tab = tabs.find((candidate) => candidate.targetId === resolved.targetId);
    if (!tab) {
      throw new BrowserTabNotFoundError({ input: targetId });
    }
    return assignTabAlias({ profileState: getProfileState(), tab, label: normalizedLabel });
  };

  return {
    listTabs,
    openTab,
    labelTab,
  };
}
