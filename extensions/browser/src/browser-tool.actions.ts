import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { normalizeOptionalString, readStringValue } from "openclaw/plugin-sdk/text-runtime";
import {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  browserAct,
  browserConsoleMessages,
  browserSnapshot,
  browserTabs,
  getBrowserProfileCapabilities,
  imageResultFromFile,
  jsonResult,
  loadConfig,
  resolveBrowserConfig,
  resolveProfile,
  wrapExternalContent,
} from "./core-api.js";

const browserToolActionDeps = {
  browserAct,
  browserConsoleMessages,
  browserSnapshot,
  browserTabs,
  imageResultFromFile,
  loadConfig,
};

export const __testing = {
  setDepsForTest(
    overrides: Partial<{
      browserAct: typeof browserAct;
      browserConsoleMessages: typeof browserConsoleMessages;
      browserSnapshot: typeof browserSnapshot;
      browserTabs: typeof browserTabs;
      imageResultFromFile: typeof imageResultFromFile;
      loadConfig: typeof loadConfig;
    }> | null,
  ) {
    browserToolActionDeps.browserAct = overrides?.browserAct ?? browserAct;
    browserToolActionDeps.browserConsoleMessages =
      overrides?.browserConsoleMessages ?? browserConsoleMessages;
    browserToolActionDeps.browserSnapshot = overrides?.browserSnapshot ?? browserSnapshot;
    browserToolActionDeps.browserTabs = overrides?.browserTabs ?? browserTabs;
    browserToolActionDeps.imageResultFromFile =
      overrides?.imageResultFromFile ?? imageResultFromFile;
    browserToolActionDeps.loadConfig = overrides?.loadConfig ?? loadConfig;
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
  const wrapped = wrapBrowserExternalJson({
    kind: "tabs",
    payload: { tabs },
    includeWarning: false,
  });
  const content: AgentToolResult<unknown>["content"] = [
    { type: "text", text: wrapped.wrappedText },
  ];
  return {
    content,
    details: { ...wrapped.safeDetails, tabCount: tabs.length },
  };
}

function formatConsoleToolResult(result: {
  targetId?: string;
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
  const cfg = browserToolActionDeps.loadConfig();
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

export async function executeTabsAction(params: {
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { baseUrl, profile, proxyRequest } = params;
  if (proxyRequest) {
    const result = await proxyRequest({
      method: "GET",
      path: "/tabs",
      profile,
    });
    const tabs = (result as { tabs?: unknown[] }).tabs ?? [];
    return formatTabsToolResult(tabs);
  }
  const tabs = await browserToolActionDeps.browserTabs(baseUrl, { profile });
  return formatTabsToolResult(tabs);
}

export async function executeSnapshotAction(params: {
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { input, baseUrl, profile, proxyRequest } = params;
  const snapshotDefaults = browserToolActionDeps.loadConfig().browser?.snapshotDefaults;
  const format: "ai" | "aria" | undefined =
    input.snapshotFormat === "ai" || input.snapshotFormat === "aria"
      ? input.snapshotFormat
      : undefined;
  const mode: "efficient" | undefined =
    input.mode === "efficient"
      ? "efficient"
      : format !== "aria" && snapshotDefaults?.mode === "efficient"
        ? "efficient"
        : undefined;
  const labels = typeof input.labels === "boolean" ? input.labels : undefined;
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
    mode,
  };
  const snapshot = proxyRequest
    ? ((await proxyRequest({
        method: "GET",
        path: "/snapshot",
        profile,
        query: snapshotQuery,
      })) as Awaited<ReturnType<typeof browserSnapshot>>)
    : await browserToolActionDeps.browserSnapshot(baseUrl, {
        ...snapshotQuery,
        profile,
      });
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
  request: Parameters<typeof browserAct>[1];
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { request, baseUrl, profile, proxyRequest } = params;
  try {
    const result = proxyRequest
      ? await proxyRequest({
          method: "POST",
          path: "/act",
          profile,
          body: request,
        })
      : await browserToolActionDeps.browserAct(baseUrl, request, {
          profile,
        });
    return jsonResult(result);
  } catch (err) {
    if (isChromeStaleTargetError(profile, err)) {
      const retryRequest = stripTargetIdFromActRequest(request);
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
      if (retryRequest && canRetryChromeActWithoutTargetId(request) && tabs.length === 1) {
        try {
          const retryResult = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/act",
                profile,
                body: retryRequest,
              })
            : await browserToolActionDeps.browserAct(baseUrl, retryRequest, {
                profile,
              });
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
