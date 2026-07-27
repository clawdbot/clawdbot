/**
 * Browser tab listing, opening, labeling, and alias management for one profile.
 */
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { resolveBrowserNavigationProxyMode } from "./browser-proxy-mode.js";
import {
  assertChromeMcpExplicitCdpUrlAllowed,
  resolveCdpControlPolicy,
} from "./cdp-reachability-policy.js";
import { isSelectableCdpBrowserTarget } from "./cdp-target-filter.js";
import { CDP_JSON_NEW_TIMEOUT_MS } from "./cdp-timeouts.js";
import {
  assertCdpEndpointAllowed,
  fetchJson,
  fetchOk,
  normalizeCdpHttpBaseForJsonEndpoints,
  resolveCdpTabOwnership,
} from "./cdp.helpers.js";
import {
  appendCdpPath,
  createTargetViaCdp,
  normalizeCdpWsUrl,
  waitForCdpCommittedNavigationUrl,
} from "./cdp.js";
import type { CdpActionTimeouts } from "./cdp.js";
import { getChromeMcpModule } from "./chrome-mcp.runtime.js";
import type { BrowserOpenResult } from "./client.types.js";
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
import {
  assignTabAlias,
  assignTabAliases,
  normalizeTabLabel,
  resolveTargetIdFromTabs,
} from "./target-id.js";

type TabOpsDeps = {
  profile: ResolvedBrowserProfile;
  state: () => BrowserServerState;
  runtime: ProfileRuntimeState;
};

type ProfileTabOps = {
  listTabs: (options?: BrowserOperationOptions) => Promise<BrowserTab[]>;
  openTab: (
    url: string,
    opts?: { label?: string; signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<BrowserOpenResult>;
  labelTab: (
    targetId: string,
    label: string,
    options?: BrowserOperationOptions,
  ) => Promise<BrowserTab>;
};

type CdpTarget = {
  id?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  type?: string;
};

/** Normalize a reported CDP WebSocket URL against the configured endpoint. */
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

/** Builds list/open/label tab operations for one resolved browser profile. */
export function createProfileTabOps({ profile, state, runtime }: TabOpsDeps): ProfileTabOps {
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
      assertChromeMcpExplicitCdpUrlAllowed(profile, getCdpControlPolicy());
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
        const wsPin = await assertCdpEndpointAllowed(tab.wsUrl, cdpControlPolicy, {
          source: "discovered",
          configuredUrl: profile.cdpUrl,
        });
        if (wsPin?.lookup) {
          tab.wsLookup = wsPin.lookup;
        }
      }
      tabs.push(tab);
    }
    return tabs;
  };

  const listTabs = async (options?: BrowserOperationOptions): Promise<BrowserTab[]> => {
    const tabs = await readTabs(options);
    // Chrome MCP target identity is authoritative. A replacement tab cannot
    // inherit an alias safely, even when its URL matches the closed tab.
    return assignTabAliases(runtime, tabs, !capabilities.usesChromeMcp);
  };

  const enforceManagedTabLimit = async (
    keepTargetId: string,
    options?: BrowserOperationOptions,
  ): Promise<void> => {
    if (!capabilities.supportsManagedTabLimit || state().resolved.attachOnly || !runtime.running) {
      return;
    }

    const pageTabs = await listTabs(options)
      .then((tabs) => tabs.filter((tab) => (tab.type ?? "page") === "page"))
      .catch(() => [] as BrowserTab[]);
    if (pageTabs.length <= MANAGED_BROWSER_PAGE_TAB_LIMIT) {
      return;
    }

    const candidates = pageTabs.filter((tab) => tab.targetId !== keepTargetId);
    const excessCount = pageTabs.length - MANAGED_BROWSER_PAGE_TAB_LIMIT;
    for (const tab of candidates.slice(0, excessCount)) {
      options?.signal?.throwIfAborted();
      await fetchOk(
        appendCdpPath(cdpHttpBase, `/json/close/${tab.targetId}`),
        undefined,
        undefined,
        getCdpControlPolicy(),
      ).catch(() => {
        // best-effort cleanup only
      });
    }
  };

  const triggerManagedTabLimit = (
    keepTargetId: string,
    options?: BrowserOperationOptions,
  ): void => {
    // This local-managed raw HTTP cleanup owns no browser process or adapter.
    // Keep it best-effort so an unresponsive old target cannot block tab creation.
    void enforceManagedTabLimit(keepTargetId, options).catch(() => {});
  };

  const adoptValidatedTab = (
    tab: BrowserTab,
    options?: BrowserOperationOptions & { label?: string },
  ): BrowserTab => {
    options?.signal?.throwIfAborted();
    // Rejected, aborted, or undiscovered opens must preserve the prior implicit target.
    // Alias and sticky state therefore change only at this final validated adoption point.
    const adopted = assignTabAlias({ profileState: runtime, tab, label: options?.label });
    runtime.lastTargetId = tab.targetId;
    triggerManagedTabLimit(tab.targetId, options);
    return adopted;
  };

  const withTabOwnership = async (
    tab: BrowserTab,
    options?: BrowserOperationOptions,
  ): Promise<BrowserOpenResult> => {
    const cdpTimeouts = getRemoteCdpActionTimeouts();
    let ownership: BrowserOpenResult["ownership"];
    try {
      ownership = await resolveCdpTabOwnership({
        profileName: profile.name,
        cdpUrl: profile.cdpUrl,
        nativeTargetId: tab.targetId,
        signal: options?.signal,
        timeoutMs: cdpTimeouts?.httpTimeoutMs,
        ssrfPolicy: getCdpControlPolicy(),
      });
    } catch (ownershipError) {
      try {
        // Ownership probing happens after target creation. Cleanup must not
        // inherit a caller abort that would strand the new untracked page.
        await fetchOk(
          appendCdpPath(cdpHttpBase, `/json/close/${encodeURIComponent(tab.targetId)}`),
          state().resolved.remoteCdpTimeoutMs,
          undefined,
          getCdpControlPolicy(),
        );
      } catch (closeError) {
        throw Object.assign(
          new Error("Failed to resolve browser tab ownership and close the new target", {
            cause: ownershipError,
          }),
          { errors: [ownershipError, closeError] },
        );
      }
      throw ownershipError;
    }
    return {
      ...tab,
      ownership,
    };
  };

  const openTab = async (
    url: string,
    opts?: { label?: string; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<BrowserOpenResult> => {
    opts?.signal?.throwIfAborted();
    const normalizedLabel = opts?.label === undefined ? undefined : normalizeTabLabel(opts.label);
    const ssrfPolicyOpts = getNavigationPolicy();

    if (capabilities.usesChromeMcp) {
      await assertBrowserNavigationAllowed({ url, ...ssrfPolicyOpts });
      const cdpPolicy = getCdpControlPolicy();
      assertChromeMcpExplicitCdpUrlAllowed(profile, cdpPolicy);
      const { openChromeMcpTab } = await getChromeMcpModule();
      const cdpTimeouts = getRemoteCdpActionTimeouts();
      const page = await openChromeMcpTab(profile.name, url, profile, {
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs,
        cdpPolicy,
        ...(cdpTimeouts ? { cdpTimeouts } : {}),
      });
      await assertBrowserNavigationResultAllowed({ url: page.url, ...ssrfPolicyOpts });
      return adoptValidatedTab(page, { ...opts, label: normalizedLabel });
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
        return adoptValidatedTab(
          await withTabOwnership(
            {
              targetId: page.targetId,
              title: page.title,
              url: page.url,
              type: page.type,
            },
            opts,
          ),
          { ...opts, label: normalizedLabel },
        );
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
      waitForNavigationResult: true,
    };
    if (cdpActionTimeouts) {
      createTargetOpts.timeouts = cdpActionTimeouts;
    }
    if (opts?.signal) {
      createTargetOpts.signal = opts.signal;
    }
    const createdViaCdp = await createTargetViaCdp(createTargetOpts).catch(() => null);
    opts?.signal?.throwIfAborted();

    if (createdViaCdp) {
      if (!createdViaCdp.finalUrl) {
        // The target exists, but its committed document is not authoritative.
        // Preserve the explicit result without sticky, alias, or cleanup adoption.
        return await withTabOwnership(
          {
            targetId: createdViaCdp.targetId,
            title: "",
            url,
            type: "page",
          },
          opts,
        );
      }
      await assertBrowserNavigationResultAllowed({
        url: createdViaCdp.finalUrl,
        ...ssrfPolicyOpts,
      });
      const deadline = Date.now() + OPEN_TAB_DISCOVERY_WINDOW_MS;
      while (Date.now() < deadline) {
        opts?.signal?.throwIfAborted();
        const tabs = await readTabs(opts).catch(() => [] as BrowserTab[]);
        const found = tabs.find((t) => t.targetId === createdViaCdp.targetId);
        if (found) {
          await assertBrowserNavigationResultAllowed({ url: found.url, ...ssrfPolicyOpts });
          // The attached target owns the committed URL; /json/list supplies the
          // remaining metadata and may briefly lag that exact document snapshot.
          return adoptValidatedTab(
            await withTabOwnership({ ...found, url: createdViaCdp.finalUrl }, opts),
            { ...opts, label: normalizedLabel },
          );
        }
        await sleepWithAbort(OPEN_TAB_DISCOVERY_POLL_MS, opts?.signal);
      }
      opts?.signal?.throwIfAborted();
      // Preserve the explicit target-id result for callers, but do not adopt an
      // undiscovered target into sticky, alias, or managed-cleanup state.
      return await withTabOwnership(
        {
          targetId: createdViaCdp.targetId,
          title: "",
          url: createdViaCdp.finalUrl,
          type: "page",
        },
        opts,
      );
    }

    const encoded = encodeURIComponent(url);
    const endpointUrl = new URL(appendCdpPath(cdpHttpBase, "/json/new"));
    const endpoint = endpointUrl.search
      ? (() => {
          endpointUrl.searchParams.set("url", url);
          return endpointUrl.toString();
        })()
      : `${endpointUrl.toString()}?${encoded}`;
    opts?.signal?.throwIfAborted();
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

    opts?.signal?.throwIfAborted();
    if (!created.id) {
      throw new Error("Failed to open tab (missing id)");
    }
    const resolvedUrl = created.url ?? url;
    if (!isSelectableCdpBrowserTarget({ url: resolvedUrl, type: created.type })) {
      throw new Error("Failed to open tab (non-selectable target)");
    }
    await assertBrowserNavigationResultAllowed({ url: resolvedUrl, ...ssrfPolicyOpts });
    const wsUrl = normalizeWsUrl(created.webSocketDebuggerUrl, profile.cdpUrl);
    const wsPin = wsUrl
      ? await assertCdpEndpointAllowed(wsUrl, getCdpControlPolicy(), {
          source: "discovered",
          configuredUrl: profile.cdpUrl,
        })
      : undefined;
    const committedUrl = wsUrl
      ? await waitForCdpCommittedNavigationUrl({
          wsUrl,
          configuredCdpUrl: profile.cdpUrl,
          cdpPolicy: getCdpControlPolicy(),
          requestedUrl: url,
          signal: opts?.signal,
          timeouts: cdpActionTimeouts,
        })
      : undefined;
    opts?.signal?.throwIfAborted();
    if (!committedUrl) {
      return await withTabOwnership(
        {
          targetId: created.id,
          title: created.title ?? "",
          url: resolvedUrl,
          wsUrl,
          ...(wsPin?.lookup ? { wsLookup: wsPin.lookup } : {}),
          type: created.type,
        },
        opts,
      );
    }
    await assertBrowserNavigationResultAllowed({ url: committedUrl, ...ssrfPolicyOpts });
    return adoptValidatedTab(
      await withTabOwnership(
        {
          targetId: created.id,
          title: created.title ?? "",
          url: committedUrl,
          wsUrl,
          ...(wsPin?.lookup ? { wsLookup: wsPin.lookup } : {}),
          type: created.type,
        },
        opts,
      ),
      { ...opts, label: normalizedLabel },
    );
  };

  const labelTab = async (
    targetId: string,
    label: string,
    options?: BrowserOperationOptions,
  ): Promise<BrowserTab> => {
    const normalizedLabel = normalizeTabLabel(label);
    const tabs = await listTabs(options);
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
    return assignTabAlias({ profileState: runtime, tab, label: normalizedLabel });
  };

  return {
    listTabs,
    openTab,
    labelTab,
  };
}
