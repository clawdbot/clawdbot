import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  browserAct,
  browserConsoleMessages,
  browserSnapshot,
  browserTabs,
  getBrowserProfileCapabilities,
  getRuntimeConfig,
  imageResultFromFile,
  jsonResult,
  normalizeOptionalString,
  readStringValue,
  resolveBrowserConfig,
  resolveProfile,
  wrapExternalContent,
} from "./browser-tool.runtime.js";
import { DEFAULT_BROWSER_ACTION_TIMEOUT_MS } from "./browser/constants.js";

const browserToolActionDeps = {
  browserAct,
  browserConsoleMessages,
  browserSnapshot,
  browserTabs,
  getRuntimeConfig,
  imageResultFromFile,
};

const BROWSER_ACT_REQUEST_TIMEOUT_SLACK_MS = 5_000;

type BrowserActRequest = Parameters<typeof browserAct>[1];
type BrowserActRequestWithTimeout = BrowserActRequest & { timeoutMs?: number };

function normalizePositiveTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function supportsBrowserActTimeout(request: BrowserActRequest): boolean {
  switch (request.kind) {
    case "click":
    case "type":
    case "hover":
    case "scrollIntoView":
    case "drag":
    case "select":
    case "fill":
    case "evaluate":
    case "wait":
      return true;
    default:
      return false;
  }
}

function existingSessionRejectsActTimeout(request: BrowserActRequest): boolean {
  switch (request.kind) {
    case "type":
    case "hover":
    case "scrollIntoView":
    case "drag":
    case "select":
    case "fill":
    case "evaluate":
      return true;
    default:
      return false;
  }
}

function usesExistingSessionProfile(profileName: string | undefined): boolean {
  const cfg = browserToolActionDeps.getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const profile = resolveProfile(resolved, profileName ?? resolved.defaultProfile);
  return profile ? getBrowserProfileCapabilities(profile).usesChromeMcp : false;
}

function withConfiguredActTimeout(
  request: BrowserActRequest,
  profileName: string | undefined,
): BrowserActRequest {
  const typedRequest = request as BrowserActRequestWithTimeout;
  if (normalizePositiveTimeoutMs(typedRequest.timeoutMs) !== undefined) {
    return request;
  }
  if (!supportsBrowserActTimeout(request)) {
    return request;
  }
  if (existingSessionRejectsActTimeout(request) && usesExistingSessionProfile(profileName)) {
    return request;
  }

  const cfg = browserToolActionDeps.getRuntimeConfig();
  const configuredTimeout =
    normalizePositiveTimeoutMs(cfg.browser?.actionTimeoutMs) ?? DEFAULT_BROWSER_ACTION_TIMEOUT_MS;
  return { ...typedRequest, timeoutMs: configuredTimeout } as BrowserActRequest;
}

function resolveActProxyTimeoutMs(request: BrowserActRequest): number | undefined {
  const candidateTimeouts: number[] = [];
  const explicitTimeout = normalizePositiveTimeoutMs(
    (request as BrowserActRequestWithTimeout).timeoutMs,
  );
  if (explicitTimeout !== undefined) {
    candidateTimeouts.push(explicitTimeout + BROWSER_ACT_REQUEST_TIMEOUT_SLACK_MS);
  }
  if (request.kind === "wait") {
    const waitDuration = normalizePositiveTimeoutMs(request.timeMs);
    if (waitDuration !== undefined) {
      candidateTimeouts.push(waitDuration + BROWSER_ACT_REQUEST_TIMEOUT_SLACK_MS);
    }
  }
  return candidateTimeouts.length ? Math.max(...candidateTimeouts) : undefined;
}

export const __testing = {
  setDepsForTest(
    overrides: Partial<{
      browserAct: typeof browserAct;
      browserConsoleMessages: typeof browserConsoleMessages;
      browserSnapshot: typeof browserSnapshot;
      browserTabs: typeof browserTabs;
      imageResultFromFile: typeof imageResultFromFile;
      getRuntimeConfig: typeof getRuntimeConfig;
    }> | null,
  ) {
    browserToolActionDeps.browserAct = overrides?.browserAct ?? browserAct;
    browserToolActionDeps.browserConsoleMessages =
      overrides?.browserConsoleMessages ?? browserConsoleMessages;
    browserToolActionDeps.browserSnapshot = overrides?.browserSnapshot ?? browserSnapshot;
    browserToolActionDeps.browserTabs = overrides?.browserTabs ?? browserTabs;
    browserToolActionDeps.imageResultFromFile =
      overrides?.imageResultFromFile ?? imageResultFromFile;
    browserToolActionDeps.getRuntimeConfig = overrides?.getRuntimeConfig ?? getRuntimeConfig;
  },
};

type BrowserProxyRequest = (opts: {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
}) => Promise<unknown>;

type BrowserTabLike = {
  suggestedTargetId?: unknown;
  tabId?: unknown;
  label?: unknown;
  title?: unknown;
  url?: unknown;
  type?: unknown;
  targetId?: unknown;
  wsUrl?: unknown;
};

function formatAgentTab(tab: unknown): Record<string, unknown> {
  if (!tab || typeof tab !== "object") {
    return { value: tab };
  }
  const source = tab as BrowserTabLike;
  const targetId = readStringValue(source.targetId);
  const tabId = readStringValue(source.tabId);
  const label = readStringValue(source.label);
  const suggestedTargetId = readStringValue(source.suggestedTargetId) ?? label ?? tabId ?? targetId;
  return {
    ...(suggestedTargetId ? { suggestedTargetId } : {}),
    ...(tabId ? { tabId } : {}),
    ...(label ? { label } : {}),
    title: source.title,
    url: source.url,
    type: source.type,
    ...(targetId ? { targetId } : {}),
    ...(source.wsUrl ? { wsUrl: source.wsUrl } : {}),
  };
}

function wrapBrowserExternalJson(params: {
  kind: "snapshot" | "console" | "tabs";
  payload: unknown;
  includeWarning?: boolean;
}): { wrappedText: string; safeDetails: Record<string, unknown> } {
  const extractedText = JSON.stringify(params.payload, null, 2);
  const wrappedText = wrapExternalContent(extractedText, {
    source: "browser",
    includeWarning: params.includeWarning ?? true,
  });
  return {
    wrappedText,
    safeDetails: {
      ok: true,
      externalContent: {
        untrusted: true,
        source: "browser",
        kind: params.kind,
        wrapped: true,
      },
    },
  };
}

function formatTabsToolResult(tabs: unknown[]): AgentToolResult<unknown> {
  const formattedTabs = tabs.map((tab) => formatAgentTab(tab));
  const wrapped = wrapBrowserExternalJson({
    kind: "tabs",
    payload: { tabs: formattedTabs },
    includeWarning: false,
  });
  const content: AgentToolResult<unknown>["content"] = [
    { type: "text", text: wrapped.wrappedText },
  ];
  return {
    content,
    details: {
      ...wrapped.safeDetails,
      tabCount: tabs.length,
      tabs: formattedTabs,
    },
  };
}

function formatConsoleToolResult(result: {
  targetId?: string;
  url?: string;
  messages?: unknown[];
}): AgentToolResult<unknown> {
  const wrapped = wrapBrowserExternalJson({
    kind: "console",
    payload: result,
    includeWarning: false,
  });
  return {
    content: [{ type: "text" as const, text: wrapped.wrappedText }],
    details: {
      ...wrapped.safeDetails,
      targetId: readStringValue(result.targetId),
      url: readStringValue(result.url),
      messageCount: Array.isArray(result.messages) ? result.messages.length : undefined,
    },
  };
}

function isChromeStaleTargetError(profile: string | undefined, err: unknown): boolean {
  if (!profile) {
    return false;
  }
  if (profile === "user") {
    const msg = String(err);
    return msg.includes("404:") && msg.includes("tab not found");
  }
  const cfg = browserToolActionDeps.getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const browserProfile = resolveProfile(resolved, profile);
  if (!browserProfile || !getBrowserProfileCapabilities(browserProfile).usesChromeMcp) {
    return false;
  }
  const msg = String(err);
  return msg.includes("404:") && msg.includes("tab not found");
}

function stripTargetIdFromActRequest(
  request: Parameters<typeof browserAct>[1],
): Parameters<typeof browserAct>[1] | null {
  const targetId = normalizeOptionalString(request.targetId);
  if (!targetId) {
    return null;
  }
  const retryRequest = { ...request };
  delete retryRequest.targetId;
  return retryRequest as Parameters<typeof browserAct>[1];
}

function canRetryChromeActWithoutTargetId(request: Parameters<typeof browserAct>[1]): boolean {
  const typedRequest = request as Partial<Record<"kind" | "action", unknown>>;
  const kind =
    typeof typedRequest.kind === "string"
      ? typedRequest.kind
      : typeof typedRequest.action === "string"
        ? typedRequest.action
        : "";
  return kind === "hover" || kind === "scrollIntoView" || kind === "wait";
}

function isAriaRefsUnsupportedError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return msg.includes("refs=aria") && msg.includes("not support");
}

function withRoleRefsFallback<T extends { refs?: "aria" | "role" }>(
  snapshotQuery: T,
): T & { refs: "role" } {
  return {
    ...snapshotQuery,
    refs: "role",
  };
}

export async function executeTabsAction(params: {
  baseUrl?: string;
  profile?: string;
  timeoutMs?: number;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { baseUrl, profile, timeoutMs, proxyRequest } = params;
  if (proxyRequest) {
    const result = await proxyRequest({
      method: "GET",
      path: "/tabs",
      profile,
      timeoutMs,
    });
    const tabs = (result as { tabs?: unknown[] }).tabs ?? [];
    return formatTabsToolResult(tabs);
  }
  const tabs = await browserToolActionDeps.browserTabs(baseUrl, { profile, timeoutMs });
  return formatTabsToolResult(tabs);
}

export async function executeSnapshotAction(params: {
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
  onTabActivity?: (targetId: string | undefined) => void;
}): Promise<AgentToolResult<unknown>> {
  const { input, baseUrl, profile, proxyRequest } = params;
  const snapshotDefaults = browserToolActionDeps.getRuntimeConfig().browser?.snapshotDefaults;
  const format: "ai" | "aria" | undefined =
    input.snapshotFormat === "ai" ? "ai" : input.snapshotFormat === "aria" ? "aria" : undefined;
  const formatExplicit = format !== undefined;
  const mode: "efficient" | undefined =
    input.mode === "efficient"
      ? "efficient"
      : !formatExplicit && format !== "aria" && snapshotDefaults?.mode === "efficient"
        ? "efficient"
        : undefined;
  const labels = typeof input.labels === "boolean" ? input.labels : undefined;
  const urls = typeof input.urls === "boolean" ? input.urls : undefined;
  const refs: "aria" | "role" | undefined =
    input.refs === "aria" || input.refs === "role" ? input.refs : undefined;
  const hasMaxChars = Object.hasOwn(input, "maxChars");
  const targetId = normalizeOptionalString(input.targetId);
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : undefined;
  const maxChars =
    typeof input.maxChars === "number" && Number.isFinite(input.maxChars) && input.maxChars > 0
      ? Math.floor(input.maxChars)
      : undefined;
  const interactive = typeof input.interactive === "boolean" ? input.interactive : undefined;
  const compact = typeof input.compact === "boolean" ? input.compact : undefined;
  const depth =
    typeof input.depth === "number" && Number.isFinite(input.depth) ? input.depth : undefined;
  const selector = normalizeOptionalString(input.selector);
  const frame = normalizeOptionalString(input.frame);
  const resolvedMaxChars =
    format === "ai"
      ? hasMaxChars
        ? maxChars
        : mode === "efficient"
          ? undefined
          : DEFAULT_AI_SNAPSHOT_MAX_CHARS
      : hasMaxChars
        ? maxChars
        : undefined;
  const snapshotQuery = {
    ...(format ? { format } : {}),
    targetId,
    limit,
    ...(typeof resolvedMaxChars === "number" ? { maxChars: resolvedMaxChars } : {}),
    refs,
    interactive,
    compact,
    depth,
    selector,
    frame,
    labels,
    urls,
    mode,
  };
  let refsFallback: "role" | undefined;
  const readSnapshot = async (query: typeof snapshotQuery) =>
    proxyRequest
      ? ((await proxyRequest({
          method: "GET",
          path: "/snapshot",
          profile,
          query,
        })) as Awaited<ReturnType<typeof browserSnapshot>>)
      : await browserToolActionDeps.browserSnapshot(baseUrl, {
          ...query,
          profile,
        });
  let snapshot: Awaited<ReturnType<typeof browserSnapshot>>;
  try {
    snapshot = await readSnapshot(snapshotQuery);
  } catch (err) {
    if (refs !== "aria" || !isAriaRefsUnsupportedError(err)) {
      throw err;
    }
    refsFallback = "role";
    snapshot = await readSnapshot(withRoleRefsFallback(snapshotQuery));
  }
  params.onTabActivity?.(readStringValue(snapshot.targetId) ?? targetId);
  if (snapshot.format === "ai") {
    const extractedText = snapshot.snapshot ?? "";
    const wrappedSnapshot = wrapExternalContent(extractedText, {
      source: "browser",
      includeWarning: true,
    });
    const safeDetails = {
      ok: true,
      format: snapshot.format,
      targetId: snapshot.targetId,
      url: snapshot.url,
      truncated: snapshot.truncated,
      stats: snapshot.stats,
      refs: snapshot.refs ? Object.keys(snapshot.refs).length : undefined,
      labels: snapshot.labels,
      labelsCount: snapshot.labelsCount,
      labelsSkipped: snapshot.labelsSkipped,
      imagePath: snapshot.imagePath,
      imageType: snapshot.imageType,
      refsFallback,
      externalContent: {
        untrusted: true,
        source: "browser",
        kind: "snapshot",
        format: "ai",
        wrapped: true,
      },
    };
    if (labels && snapshot.imagePath) {
      return await browserToolActionDeps.imageResultFromFile({
        label: "browser:snapshot",
        path: snapshot.imagePath,
        extraText: wrappedSnapshot,
        details: safeDetails,
      });
    }
    return {
      content: [{ type: "text" as const, text: wrappedSnapshot }],
      details: safeDetails,
    };
  }
  {
    const wrapped = wrapBrowserExternalJson({
      kind: "snapshot",
      payload: snapshot,
    });
    return {
      content: [{ type: "text" as const, text: wrapped.wrappedText }],
      details: {
        ...wrapped.safeDetails,
        format: "aria",
        targetId: snapshot.targetId,
        url: snapshot.url,
        nodeCount: snapshot.nodes.length,
        externalContent: {
          untrusted: true,
          source: "browser",
          kind: "snapshot",
          format: "aria",
          wrapped: true,
        },
      },
    };
  }
}

export async function executeConsoleAction(params: {
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { input, baseUrl, profile, proxyRequest } = params;
  const level = normalizeOptionalString(input.level);
  const targetId = normalizeOptionalString(input.targetId);
  if (proxyRequest) {
    const result = (await proxyRequest({
      method: "GET",
      path: "/console",
      profile,
      query: {
        level,
        targetId,
      },
    })) as { ok?: boolean; targetId?: string; messages?: unknown[] };
    return formatConsoleToolResult(result);
  }
  const result = await browserToolActionDeps.browserConsoleMessages(baseUrl, {
    level,
    targetId,
    profile,
  });
  return formatConsoleToolResult(result);
}

export async function executeActAction(params: {
  request: BrowserActRequest;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
  onTabActivity?: (targetId: string | undefined) => void;
}): Promise<AgentToolResult<unknown>> {
  const { request, baseUrl, profile, proxyRequest } = params;
  const effectiveRequest = withConfiguredActTimeout(request, profile);
  try {
    const result = proxyRequest
      ? await proxyRequest({
          method: "POST",
          path: "/act",
          profile,
          body: effectiveRequest,
          timeoutMs: resolveActProxyTimeoutMs(effectiveRequest),
        })
      : await browserToolActionDeps.browserAct(baseUrl, effectiveRequest, {
          profile,
        });
    params.onTabActivity?.(
      readStringValue((result as { targetId?: unknown }).targetId) ??
        readStringValue(effectiveRequest.targetId),
    );
    return jsonResult(result);
  } catch (err) {
    if (isChromeStaleTargetError(profile, err)) {
      const retryRequest = stripTargetIdFromActRequest(effectiveRequest);
      const tabs = proxyRequest
        ? ((
            (await proxyRequest({
              method: "GET",
              path: "/tabs",
              profile,
            })) as { tabs?: unknown[] }
          ).tabs ?? [])
        : await browserToolActionDeps.browserTabs(baseUrl, { profile }).catch(() => []);
      // Some user-browser targetIds can go stale between snapshots and actions.
      // Only retry safe read-only actions, and only when exactly one tab remains attached.
      if (retryRequest && canRetryChromeActWithoutTargetId(effectiveRequest) && tabs.length === 1) {
        try {
          const retryResult = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/act",
                profile,
                body: retryRequest,
                timeoutMs: resolveActProxyTimeoutMs(retryRequest),
              })
            : await browserToolActionDeps.browserAct(baseUrl, retryRequest, {
                profile,
              });
          params.onTabActivity?.(
            readStringValue((retryResult as { targetId?: unknown }).targetId) ??
              readStringValue(retryRequest.targetId),
          );
          return jsonResult(retryResult);
        } catch {
          // Fall through to explicit stale-target guidance.
        }
      }
      if (!tabs.length) {
        throw new Error(
          `No browser tabs found for profile="${profile}". Make sure the configured Chromium-based browser (v144+) is running and has open tabs, then retry.`,
          { cause: err },
        );
      }
      throw new Error(
        `Chrome tab not found (stale targetId?). Run action=tabs profile="${profile}" and use one of the returned targetIds.`,
        { cause: err },
      );
    }
    throw err;
  }
}
