/**
 * Browser agent tool snapshot execution and inline page-state feedback.
 *
 * Owns the model-facing snapshot result shape (untrusted-content wrapping,
 * caps, dialog states) and attaches fresh page state to actions that changed
 * the page document so the model does not need a follow-up snapshot call.
 */
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
} from "openclaw/plugin-sdk/param-readers";
import {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  browserSnapshot,
  getRuntimeConfig,
  imageResultFromFile,
  normalizeOptionalString,
  readStringValue,
  resolveRuntimeImageSanitization,
  wrapExternalContent,
} from "./browser-tool.runtime.js";
import { DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS } from "./browser/constants.js";
import { neutralizeMediaDirectives } from "./browser/vision.js";
import { formatErrorMessage } from "./infra/errors.js";

export type BrowserProxyRequest = ((opts: {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
  signal?: AbortSignal;
}) => Promise<unknown>) & {
  // Present on node-proxy requests: reports whether the proxy silently fell
  // back to the Gateway host browser after the node became unreachable.
  isHostFallbackActive?: () => boolean;
};

/** Wrap page-controlled JSON payloads as untrusted browser content. */
export function wrapBrowserExternalJson(params: {
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

/** Execute and format browser snapshots for agent consumption. */
export async function executeSnapshotAction(params: {
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
  onTabActivity?: (targetId: string | undefined) => void;
}): Promise<AgentToolResult<unknown>> {
  const { input, baseUrl, profile, proxyRequest } = params;
  const snapshotDefaults = getRuntimeConfig().browser?.snapshotDefaults;
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
      : await browserSnapshot(baseUrl, {
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
      newElements: snapshot.newElements,
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
      return await imageResultFromFile({
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

function withPageStateUnavailableHint(
  result: AgentToolResult<unknown>,
  reason: string,
): AgentToolResult<unknown> {
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: `[page snapshot unavailable: ${reason}. Use action=snapshot to read the page.]`,
      },
    ],
  };
}

/**
 * Attach fresh page state to the result of an action that changed the page
 * document (navigate, act that navigated). The model can act on the new page
 * without a follow-up snapshot call. The inline state uses the efficient
 * interactive tier so the unsolicited payload stays bounded on every profile
 * (mode=efficient forces the capped ai format even where the profile default
 * would be an uncapped aria tree); a full snapshot stays one explicit call away.
 */
export async function appendNavigatedPageState(params: {
  result: AgentToolResult<unknown>;
  targetId?: string;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const hostFallbackWasActive = params.proxyRequest?.isHostFallbackActive?.() ?? false;
  let snapshot: AgentToolResult<unknown>;
  try {
    snapshot = await executeSnapshotAction({
      input: { targetId: params.targetId, mode: "efficient" },
      baseUrl: params.baseUrl,
      profile: params.profile,
      proxyRequest: params.proxyRequest,
    });
  } catch (err) {
    // Cancellation must keep aborting the whole tool call; only genuine
    // snapshot failures degrade, because page state is feedback on an
    // already-successful mutation and must not fail the action.
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    return withPageStateUnavailableHint(
      params.result,
      neutralizeMediaDirectives(formatErrorMessage(err)),
    );
  }
  if (!hostFallbackWasActive && params.proxyRequest?.isHostFallbackActive?.()) {
    // The node became unreachable between the action and this snapshot and the
    // proxy fell back to the Gateway host browser: that snapshot describes a
    // different browser, so presenting it as the navigated page misleads the model.
    return withPageStateUnavailableHint(params.result, "the browser node became unreachable");
  }
  const baseDetails =
    params.result.details && typeof params.result.details === "object"
      ? (params.result.details as Record<string, unknown>)
      : {};
  return {
    content: [...params.result.content, ...snapshot.content],
    details: { ...baseDetails, pageState: snapshot.details },
  };
}
