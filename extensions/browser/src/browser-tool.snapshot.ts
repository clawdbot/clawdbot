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
import { truncateSanitizedExternalContent } from "openclaw/plugin-sdk/security-runtime";
import { DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS } from "openclaw/plugin-sdk/text-utility-runtime";
import type { BrowserProxyRequest } from "./browser-node-proxy.js";
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
import { finalizeRoleSnapshot, findRoleSnapshotLineRef } from "./browser/pw-role-snapshot.js";
import { neutralizeMediaDirectives } from "./browser/vision.js";
import { formatErrorMessage } from "./infra/errors.js";

type BrowserExternalJsonKind =
  | "snapshot"
  | "console"
  | "requests"
  | "errors"
  | "tabs"
  | "act"
  | "download";

const BROWSER_EXTERNAL_JSON_TRUNCATION_MARKERS = {
  snapshot: "\n[truncated — retry with a smaller maxChars or limit]",
  console: "\n[truncated — retry with a stricter level or targetId]",
  requests: "\n[truncated — retry with a narrower filter or smaller limit]",
  errors: "\n[truncated — retry with a smaller limit]",
  tabs: "\n[truncated — retry with action=snapshot and a specific targetId]",
  act: "\n[truncated — inspect the affected targetId with action=snapshot]",
  download: "\n[truncated — retry with a specific targetId and download ref]",
} satisfies Record<BrowserExternalJsonKind, string>;

function truncateBrowserToolText(value: string, marker: string, maxChars: number) {
  const bounded = truncateSanitizedExternalContent(value, maxChars);
  if (!bounded.truncated) {
    return bounded;
  }
  if (marker.length > maxChars) {
    return bounded;
  }
  const marked = truncateSanitizedExternalContent(value, Math.max(0, maxChars - marker.length));
  return {
    text: `${marked.text}${marker}`,
    truncated: true,
  };
}

/** Bound and wrap browser-originated text before it reaches the model. */
export function wrapBrowserExternalText(params: {
  value: string;
  marker: string;
  includeWarning: boolean;
  maxChars?: number;
  prefix?: string;
}) {
  const wrap = (value: string) =>
    wrapExternalContent(value, {
      source: "browser",
      includeWarning: params.includeWarning,
    });
  const prefix = params.prefix ? `${params.prefix}\n` : "";
  const wrapperOverhead = prefix.length + wrap("").length;
  let maxInnerChars = Math.max(
    0,
    Math.min(params.maxChars ?? Infinity, DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS - wrapperOverhead),
  );
  const value = neutralizeMediaDirectives(params.value);
  let bounded = truncateBrowserToolText(value, params.marker, maxInnerChars);
  let wrappedText = prefix + wrap(bounded.text);
  if (wrappedText.length > DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS) {
    maxInnerChars = Math.max(
      0,
      maxInnerChars - (wrappedText.length - DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS),
    );
    bounded = truncateBrowserToolText(value, params.marker, maxInnerChars);
    wrappedText = prefix + wrap(bounded.text);
  }
  return { text: wrappedText, boundedText: bounded.text, truncated: bounded.truncated };
}

/** Wrap page-controlled JSON payloads as untrusted browser content. */
export function wrapBrowserExternalJson(params: {
  kind: BrowserExternalJsonKind;
  payload: unknown;
  includeWarning?: boolean;
}): { wrappedText: string; truncated: boolean; safeDetails: Record<string, unknown> } {
  const serialized =
    JSON.stringify(
      params.payload,
      (_key: string, value: unknown) =>
        typeof value === "string" ? neutralizeMediaDirectives(value) : value,
      2,
    ) ?? "null";
  // Browser tabs, snapshots, and console output are page-controlled data. Keep
  // text wrapped even when details carry the structured fields for callers.
  const wrapped = wrapBrowserExternalText({
    value: serialized,
    marker: BROWSER_EXTERNAL_JSON_TRUNCATION_MARKERS[params.kind],
    includeWarning: params.includeWarning ?? true,
  });
  return {
    wrappedText: wrapped.text,
    truncated: wrapped.truncated,
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

/** Keep debug log counts aligned with complete records inside the output budget. */
export function formatBrowserDebugLogResult(
  kind: "requests" | "errors",
  result: { ok: true; targetId: string; url?: string },
  entries: unknown[],
  limit: number,
): AgentToolResult<unknown> {
  const total = entries.length;
  const records = entries.slice(-limit);
  const details = () => ({
    ok: result.ok,
    targetId: result.targetId,
    url: result.url,
    total,
    returned: records.length,
    truncated: records.length < total,
  });
  const wrap = () =>
    wrapBrowserExternalJson({
      kind,
      payload: { ...details(), [kind]: records },
      includeWarning: false,
    });
  let wrapped = wrap();
  // Drop whole records so large URLs or stacks cannot leave partial JSON or
  // report more returned entries than the model actually receives.
  while (wrapped.truncated && records.length > 0) {
    records.shift();
    wrapped = wrap();
  }
  return {
    content: [{ type: "text", text: wrapped.wrappedText }],
    details: {
      ...wrapped.safeDetails,
      ...details(),
      truncated: records.length < total || wrapped.truncated,
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
  signal?: AbortSignal;
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
          signal: params.signal,
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
  const query = normalizeOptionalString(input.query);
  if (query && !snapshot.blockedByDialog) {
    const tokens = query.toLowerCase().split(/\s+/);
    const source =
      snapshot.format === "ai"
        ? snapshot.snapshot
        : snapshot.nodes
            .map(
              (node) =>
                `- ${node.role} ${JSON.stringify(node.name)} [ref=${node.ref}]${node.value ? ` value=${JSON.stringify(node.value)}` : ""}${node.description ? ` description=${JSON.stringify(node.description)}` : ""}`,
            )
            .join("\n");
    const matches = source.split("\n").filter((line) => {
      const lower = line.toLowerCase();
      return tokens.every((token) => lower.includes(token));
    });
    const matchedText = matches.join("\n");
    const matchCount = matches.length;
    const summary = matchCount
      ? `${matchCount} matching line(s) in the returned snapshot${snapshot.truncated ? " (source truncated)" : ""}.`
      : "No matching lines in the returned snapshot. Refine the query or take a broader snapshot.";
    const wrapped = wrapBrowserExternalText({
      value: matchedText,
      marker: BROWSER_EXTERNAL_JSON_TRUNCATION_MARKERS.snapshot,
      maxChars: maxChars ?? DEFAULT_AI_SNAPSHOT_MAX_CHARS,
      includeWarning: true,
      prefix: summary,
    });
    const snapshotRefs =
      snapshot.format === "ai"
        ? (snapshot.refs ?? {})
        : Object.fromEntries(
            snapshot.nodes.map((node) => [node.ref, { role: node.role, name: node.name }]),
          );
    const filtered = finalizeRoleSnapshot({ snapshot: wrapped.boundedText, refs: snapshotRefs });
    const newElements = filtered.snapshot
      .split("\n")
      .filter((line) => line.endsWith(" [new]") && findRoleSnapshotLineRef(line)).length;
    const result = {
      content: [{ type: "text", text: wrapped.text }],
      details: {
        ok: snapshot.ok,
        format: snapshot.format,
        targetId: snapshot.targetId,
        url: snapshot.url,
        matchCount,
        stats: filtered.stats,
        refs: filtered.stats.refs,
        ...(snapshot.format === "ai" && snapshot.newElements !== undefined ? { newElements } : {}),
        truncated: snapshot.truncated || wrapped.truncated || undefined,
        ...(snapshot.browserState !== undefined ? { browserState: snapshot.browserState } : {}),
        ...(snapshot.format === "ai"
          ? {
              labels: snapshot.labels,
              labelsCount: snapshot.labelsCount,
              labelsSkipped: snapshot.labelsSkipped,
              annotations: snapshot.annotations,
              imagePath: snapshot.imagePath,
              imageType: snapshot.imageType,
              refsFallback,
            }
          : {}),
        externalContent: {
          untrusted: true,
          source: "browser",
          kind: "snapshot",
          format: snapshot.format,
          wrapped: true,
        },
      },
    } satisfies AgentToolResult<unknown>;
    if (labels && snapshot.format === "ai" && snapshot.imagePath) {
      return await imageResultFromFile({
        label: "browser:snapshot",
        path: snapshot.imagePath,
        extraText: result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
        details: { ...result.details, media: { outbound: false } },
        imageSanitization: resolveRuntimeImageSanitization(),
      });
    }
    return result;
  }
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
    const boundedSnapshot = wrapBrowserExternalText({
      value: snapshot.snapshot ?? "",
      marker: BROWSER_EXTERNAL_JSON_TRUNCATION_MARKERS.snapshot,
      includeWarning: true,
    });
    const safeDetails = {
      ok: true,
      format: snapshot.format,
      targetId: snapshot.targetId,
      url: snapshot.url,
      truncated: snapshot.truncated || boundedSnapshot.truncated ? true : undefined,
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
        extraText: boundedSnapshot.text,
        // Keep model-only screenshots out of automatic channel delivery.
        details: { ...safeDetails, media: { outbound: false } },
        imageSanitization: resolveRuntimeImageSanitization(),
      });
    }
    return {
      content: [{ type: "text" as const, text: boundedSnapshot.text }],
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
  signal?: AbortSignal;
}): Promise<AgentToolResult<unknown>> {
  let snapshot: AgentToolResult<unknown>;
  try {
    snapshot = await executeSnapshotAction({
      input: { targetId: params.targetId, mode: "efficient" },
      baseUrl: params.baseUrl,
      profile: params.profile,
      proxyRequest: params.proxyRequest,
      signal: params.signal,
    });
  } catch (err) {
    // Cancellation must keep aborting the whole tool call; only genuine
    // snapshot failures degrade, because page state is feedback on an
    // already-successful mutation and must not fail the action.
    params.signal?.throwIfAborted();
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    return withPageStateUnavailableHint(
      params.result,
      wrapExternalContent(neutralizeMediaDirectives(formatErrorMessage(err)), {
        source: "browser",
        includeWarning: false,
      }),
    );
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
