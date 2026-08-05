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
  browserAct,
  browserConsoleMessages,
  browserDownload,
  browserTabs,
  browserWaitForDownload,
  getBrowserProfileCapabilities,
  getRuntimeConfig,
  jsonResult,
  normalizeOptionalString,
  readStringParam,
  readStringValue,
  resolveBrowserConfig,
  resolveProfile,
} from "./browser-tool.runtime.js";
import {
  appendNavigatedPageState,
  wrapBrowserExternalJson,
  type BrowserProxyRequest,
} from "./browser-tool.snapshot.js";
import { resolveBrowserActRequestTimeoutMs } from "./browser/act-policy.js";
import type {
  BrowserBatchAbort,
  BrowserBatchActionResult,
} from "./browser/client-actions-types.js";
import {
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS,
} from "./browser/constants.js";

const browserToolActionDeps = {
  browserAct,
  browserConsoleMessages,
  browserDownload,
  browserTabs,
  browserWaitForDownload,
  getRuntimeConfig,
};

const BROWSER_DOWNLOAD_REQUEST_TIMEOUT_SLACK_MS = 5_000;
export { executeExtractAction } from "./browser-extract.js";

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

  return { ...typedRequest, timeoutMs: DEFAULT_BROWSER_ACTION_TIMEOUT_MS } as BrowserActRequest;
}

function resolveActProxyTimeoutMs(request: BrowserActRequest): number | undefined {
  return resolveBrowserActRequestTimeoutMs(request);
}

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

/** Protect page-controlled model text while preserving the shipped structured result contract. */
export function formatBrowserExternalToolResult(params: {
  kind: "act" | "download" | "tabs";
  payload: unknown;
}): AgentToolResult<unknown> {
  const result = jsonResult(params.payload);
  const wrapped = wrapBrowserExternalJson({
    kind: params.kind,
    payload: params.payload,
    includeWarning: false,
  });
  // The Browser tool already marks the turn as network-tainted, and replay
  // strips details; changing this public structured payload breaks callers.
  return {
    ...result,
    content: [{ type: "text", text: wrapped.wrappedText }],
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

export async function executeTabsAction(params: {
  baseUrl?: string;
  profile?: string;
  timeoutMs?: number;
  proxyRequest: BrowserProxyRequest | null;
  targetId?: string;
}): Promise<AgentToolResult<unknown>> {
  const { baseUrl, profile, timeoutMs, proxyRequest } = params;
  if (proxyRequest) {
    const result = await proxyRequest({
      method: "GET",
      path: "/tabs",
      profile,
      timeoutMs,
    });
    const tabs = ((result as { tabs?: unknown[] }).tabs ?? []).filter(
      (tab) =>
        !params.targetId ||
        readStringValue((tab as { targetId?: unknown } | undefined)?.targetId) === params.targetId,
    );
    return formatTabsToolResult(tabs);
  }
  const tabs = (await browserToolActionDeps.browserTabs(baseUrl, { profile, timeoutMs })).filter(
    (tab) => !params.targetId || readStringValue(tab.targetId) === params.targetId,
  );
  return formatTabsToolResult(tabs);
}

/** Validate the /act wire payload's abort summary once for note and page-state decisions. */
function readBrowserBatchAbort(result: unknown): BrowserBatchAbort | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const aborted = (result as { aborted?: unknown }).aborted;
  if (!aborted || typeof aborted !== "object") {
    return null;
  }
  const { reason, afterAction, url, skipped } = aborted as Partial<
    Record<keyof BrowserBatchAbort, unknown>
  >;
  if (
    (reason !== "navigation" && reason !== "closed") ||
    typeof afterAction !== "number" ||
    typeof url !== "string" ||
    typeof skipped !== "number"
  ) {
    return null;
  }
  return { reason, afterAction, url, skipped };
}

/** True when an /act response reports a cross-document navigation. */
function actObservedNavigation(result: unknown, aborted: BrowserBatchAbort | null): boolean {
  if (aborted?.reason === "navigation") {
    return true;
  }
  const results = (result as { results?: unknown } | null | undefined)?.results;
  return (
    Array.isArray(results) &&
    results.some(
      (entry) => (entry as Partial<BrowserBatchActionResult> | undefined)?.navigated === true,
    )
  );
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
  return formatBrowserExternalToolResult({ kind: "download", payload: result });
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
  // resolvedTargetId is the id the act actually ran against (retry paths swap
  // it), so page-state capture must use it rather than the original request's.
  const finishActResult = async (result: unknown, resolvedTargetId: string | undefined) => {
    params.onTabActivity?.(resolvedTargetId);
    const aborted = readBrowserBatchAbort(result);
    const formatted = formatActToolResult(result, aborted);
    if (!actObservedNavigation(result, aborted)) {
      return formatted;
    }
    // Batch aborts snapshot at navigation commit, so a slow page can still be
    // loading; the model may need one follow-up snapshot for late content.
    return await appendNavigatedPageState({
      result: formatted,
      targetId: resolvedTargetId,
      baseUrl,
      profile,
      proxyRequest,
    });
  };
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
    return await finishActResult(
      result,
      readStringValue((result as { targetId?: unknown }).targetId) ??
        readStringValue(effectiveRequest.targetId),
    );
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
        return await finishActResult(
          retryResult,
          readStringValue((retryResult as { targetId?: unknown }).targetId) ??
            readStringValue(retryRequest.targetId),
        );
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

function formatActToolResult(
  result: unknown,
  aborted: BrowserBatchAbort | null,
): AgentToolResult<unknown> {
  const formatted = formatBrowserExternalToolResult({ kind: "act", payload: result });
  if (!aborted) {
    return formatted;
  }
  // Navigation aborts get fresh page state (or an unavailable hint) appended by
  // finishActResult, so only the closed case tells the model to snapshot manually.
  const note =
    aborted.reason === "navigation"
      ? `Batch aborted after action ${aborted.afterAction} because the page navigated; ${aborted.skipped} remaining action(s) skipped. Earlier refs are stale.`
      : `Batch aborted after action ${aborted.afterAction} because the page or browser context closed; ${aborted.skipped} remaining action(s) skipped. Take a new snapshot before continuing.`;
  return {
    ...formatted,
    content: [...formatted.content, { type: "text", text: note }],
  };
}
