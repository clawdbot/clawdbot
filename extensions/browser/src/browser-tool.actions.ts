/**
 * Browser agent tool action executors.
 *
 * Converts model-facing parameters into browser control client calls and wraps
 * browser-originated text as untrusted content before returning it to agents.
 */
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
} from "openclaw/plugin-sdk/param-readers";
import {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  browserAct,
  browserConsoleMessages,
  browserDownload,
  browserSnapshot,
  browserTabs,
  browserWaitForDownload,
  getBrowserProfileCapabilities,
  getRuntimeConfig,
  imageResultFromFile,
  jsonResult,
  normalizeOptionalString,
  readStringParam,
  readStringValue,
  resolveBrowserConfig,
  resolveProfile,
  resolveRuntimeImageSanitization,
  wrapExternalContent,
} from "./browser-tool.runtime.js";
import { resolveBrowserActRequestTimeoutMs } from "./browser/act-policy.js";
import {
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS,
} from "./browser/constants.js";
import { neutralizeMediaDirectives } from "./browser/vision.js";

const browserToolActionDeps = {
  browserAct,
  browserConsoleMessages,
  browserDownload,
  browserSnapshot,
  browserTabs,
  browserWaitForDownload,
  getRuntimeConfig,
  imageResultFromFile,
};

const BROWSER_DOWNLOAD_REQUEST_TIMEOUT_SLACK_MS = 5_000;

type BrowserActRequest = Parameters<typeof browserAct>[1];
type BrowserActRequestWithTimeout = BrowserActRequest & { timeoutMs?: number };

function normalizePositiveTimeoutMs(value: unknown): number | undefined {
  return readPositiveIntegerParam({ value }, "value", {
    message: "timeoutMs must be a positive integer.",
  });
}

function normalizeNonNegativeDurationMs(value: unknown): number | undefined {
  return readNonNegativeIntegerParam({ value }, "value", {
    message: "timeMs must be a non-negative integer.",
  });
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
    // Chrome MCP existing-session actions reject per-call timeouts for these
    // operations, so default timeout injection must stay disabled there.
    return request;
  }

  const cfg = browserToolActionDeps.getRuntimeConfig();
  const configuredTimeout =
    normalizePositiveTimeoutMs(cfg.browser?.actionTimeoutMs) ?? DEFAULT_BROWSER_ACTION_TIMEOUT_MS;
  return { ...typedRequest, timeoutMs: configuredTimeout } as BrowserActRequest;
}

function resolveActProxyTimeoutMs(request: BrowserActRequest): number | undefined {
  return resolveBrowserActRequestTimeoutMs(request);
}

export const testing = {
  setDepsForTest(
    overrides: Partial<{
      browserAct: typeof browserAct;
      browserConsoleMessages: typeof browserConsoleMessages;
      browserDownload: typeof browserDownload;
      browserSnapshot: typeof browserSnapshot;
      browserTabs: typeof browserTabs;
      browserWaitForDownload: typeof browserWaitForDownload;
      imageResultFromFile: typeof imageResultFromFile;
      getRuntimeConfig: typeof getRuntimeConfig;
    }> | null,
  ) {
    browserToolActionDeps.browserAct = overrides?.browserAct ?? browserAct;
    browserToolActionDeps.browserConsoleMessages =
      overrides?.browserConsoleMessages ?? browserConsoleMessages;
    browserToolActionDeps.browserDownload = overrides?.browserDownload ?? browserDownload;
    browserToolActionDeps.browserSnapshot = overrides?.browserSnapshot ?? browserSnapshot;
    browserToolActionDeps.browserTabs = overrides?.browserTabs ?? browserTabs;
    browserToolActionDeps.browserWaitForDownload =
      overrides?.browserWaitForDownload ?? browserWaitForDownload;
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
  const extractedText = JSON.stringify(
    params.payload,
    (_key: string, value: unknown) =>
      typeof value === "string" ? neutralizeMediaDirectives(value) : value,
    2,
  );
  // Browser tabs, snapshots, and console output are page-controlled data. Keep
  // text wrapped even when details carry the structured fields for callers.
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
  const status =
    err && typeof err === "object" && "status" in err ? (err as { status?: unknown }).status : null;
  const msg = String(err);
  const isTabNotFound = (status === 404 || msg.includes("404:")) && msg.includes("tab not found");
  if (profile === "user") {
    return isTabNotFound;
  }
  const cfg = browserToolActionDeps.getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const browserProfile = resolveProfile(resolved, profile);
  if (!browserProfile || !getBrowserProfileCapabilities(browserProfile).usesChromeMcp) {
    return false;
  }
  return isTabNotFound;
}

function replaceStaleTargetIdInActRequest(
  request: BrowserActRequest,
  targetId: string,
): BrowserActRequest | null {
  if (!normalizeOptionalString(request.targetId) || !targetId) {
    return null;
  }
  return { ...request, targetId } as BrowserActRequest;
}

function canRetryChromeActAfterSoleTargetRefresh(request: BrowserActRequest): boolean {
  if (request.kind !== "wait" || normalizeNonNegativeDurationMs(request.timeMs) === undefined) {
    return false;
  }
  return [
    request.fn,
    request.text,
    request.textGone,
    request.selector,
    request.url,
    request.loadState,
  ].every((value) => !normalizeOptionalString(value));
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

/** Execute and format browser snapshots for agent consumption. */
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
  const limit = readPositiveIntegerParam(input, "limit", {
    message: "limit must be a positive integer.",
  });
  const maxCharsRaw = readNonNegativeIntegerParam(input, "maxChars", {
    message: "maxChars must be a non-negative integer.",
  });
  const maxChars = maxCharsRaw !== undefined && maxCharsRaw > 0 ? maxCharsRaw : undefined;
  const interactive = typeof input.interactive === "boolean" ? input.interactive : undefined;
  const compact = typeof input.compact === "boolean" ? input.compact : undefined;
  const depth = readNonNegativeIntegerParam(input, "depth", {
    message: "depth must be a non-negative integer.",
  });
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
  // AI snapshots have a compact default cap; ARIA snapshots keep full structure
  // unless maxChars is explicit, because agents often need complete node refs.
  const snapshotTimeoutMs =
    readPositiveIntegerParam(input, "timeoutMs", {
      message: "timeoutMs must be a positive integer.",
    }) ?? DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS;
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
    timeoutMs: snapshotTimeoutMs,
  };
  let refsFallback: "role" | undefined;
  const readSnapshot = async (query: typeof snapshotQuery) =>
    proxyRequest
      ? ((await proxyRequest({
          method: "GET",
          path: "/snapshot",
          profile,
          query,
          timeoutMs: snapshotTimeoutMs,
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
    const dialogStateFields = {
      ...(snapshot.blockedByDialog ? { blockedByDialog: true } : {}),
      ...(snapshot.browserState !== undefined ? { browserState: snapshot.browserState } : {}),
    };
    if (snapshot.blockedByDialog) {
      const wrapped = wrapBrowserExternalJson({
        kind: "snapshot",
        payload: {
          format: snapshot.format,
          targetId: snapshot.targetId,
          url: snapshot.url,
          ...dialogStateFields,
        },
      });
      return {
        content: [{ type: "text" as const, text: wrapped.wrappedText }],
        details: {
          ...wrapped.safeDetails,
          format: snapshot.format,
          targetId: snapshot.targetId,
          url: snapshot.url,
          ...dialogStateFields,
        },
      };
    }
    const extractedText = snapshot.snapshot ?? "";
    const wrappedSnapshot = wrapExternalContent(neutralizeMediaDirectives(extractedText), {
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
      annotations: snapshot.annotations,
      imagePath: snapshot.imagePath,
      imageType: snapshot.imageType,
      refsFallback,
      ...dialogStateFields,
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
        imageSanitization: resolveRuntimeImageSanitization(),
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
        ...(snapshot.blockedByDialog ? { blockedByDialog: true } : {}),
        ...(snapshot.browserState !== undefined ? { browserState: snapshot.browserState } : {}),
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

/** Execute browser console retrieval and wrap page-controlled messages. */
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

function resolveDownloadProxyTimeoutMs(timeoutMs: number | undefined): number {
  const waitTimeoutMs = timeoutMs ?? DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS;
  // The node proxy must outlive the browser-server request; callBrowserProxy
  // adds a second grace window for the outer Gateway node.invoke call.
  return waitTimeoutMs + BROWSER_DOWNLOAD_REQUEST_TIMEOUT_SLACK_MS;
}

type BrowserDownloadRequest =
  | { action: "download"; route: "/download"; ref: string; path: string }
  | { action: "waitfordownload"; route: "/wait/download"; path?: string };

function readBrowserDownloadRequest(
  action: BrowserDownloadRequest["action"],
  input: Record<string, unknown>,
): BrowserDownloadRequest {
  if (action === "download") {
    return {
      action,
      route: "/download",
      ref: readStringParam(input, "ref", { required: true }),
      path: readStringParam(input, "path", { required: true }),
    };
  }
  return {
    action,
    route: "/wait/download",
    path: readStringParam(input, "path"),
  };
}

/** Execute explicit Browser download operations through the local or node-host path. */
export async function executeDownloadAction(params: {
  action: "download" | "waitfordownload";
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
  onTabActivity?: (targetId: string | undefined) => void;
}): Promise<AgentToolResult<unknown>> {
  const { action, input, baseUrl, profile, proxyRequest } = params;
  const targetId = normalizeOptionalString(input.targetId);
  const timeoutMs = normalizePositiveTimeoutMs(input.timeoutMs);
  const request = readBrowserDownloadRequest(action, input);
  const result = proxyRequest
    ? await proxyRequest({
        method: "POST",
        path: request.route,
        profile,
        timeoutMs: resolveDownloadProxyTimeoutMs(timeoutMs),
        body:
          request.action === "download"
            ? { ref: request.ref, path: request.path, targetId, timeoutMs }
            : { path: request.path, targetId, timeoutMs },
      })
    : request.action === "download"
      ? await browserToolActionDeps.browserDownload(baseUrl, {
          ref: request.ref,
          path: request.path,
          targetId,
          timeoutMs,
          profile,
        })
      : await browserToolActionDeps.browserWaitForDownload(baseUrl, {
          path: request.path,
          targetId,
          timeoutMs,
          profile,
        });
  params.onTabActivity?.(readStringValue((result as { targetId?: unknown }).targetId) ?? targetId);
  return jsonResult(result);
}

/** Execute browser actions with profile-aware timeout defaults and stale-tab recovery. */
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
      const tabs = proxyRequest
        ? ((
            (await proxyRequest({
              method: "GET",
              path: "/tabs",
              profile,
            })) as { tabs?: unknown[] }
          ).tabs ?? [])
        : await browserToolActionDeps.browserTabs(baseUrl, { profile }).catch(() => []);
      const freshTargetId =
        tabs.length === 1
          ? readStringValue((tabs[0] as { targetId?: unknown } | undefined)?.targetId)
          : undefined;
      const retryRequest = freshTargetId
        ? replaceStaleTargetIdInActRequest(effectiveRequest, freshTargetId)
        : null;
      // This is same-agent continuity, not identity recovery: only target-independent
      // waits may retry, against the one freshly listed tab. Ref-scoped and scripted
      // operations require explicit fresh selection (and a fresh snapshot for refs).
      if (
        retryRequest &&
        canRetryChromeActAfterSoleTargetRefresh(effectiveRequest) &&
        tabs.length === 1
      ) {
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
export { testing as __testing };
