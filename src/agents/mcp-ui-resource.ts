import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import { completeDeferredSessionMcpRuntimeRetirement } from "./agent-bundle-mcp-runtime.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { clearMcpAppModelContextForView } from "./mcp-app-model-context.js";
import { type McpAppCsp, normalizeMcpAppCsp } from "./mcp-app-sandbox.js";

const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const MCP_APP_RESOURCE_MAX_BYTES = 2 * 1024 * 1024;
const MCP_APP_VIEW_TTL_MS = 10 * 60_000;
const MCP_APP_VIEW_MAX_ENTRIES = 32;
const MCP_APP_VIEW_MAX_BYTES = 6 * 1024 * 1024;
const MCP_APP_VIEW_STORE_MAX_BYTES = 64 * 1024 * 1024;
const MCP_APP_VIEW_STORE_KEY = Symbol.for("openclaw.mcpAppViewStore");

type McpAppPermissions = Partial<
  Record<"camera" | "clipboardWrite" | "geolocation" | "microphone", Record<string, never>>
>;

export type McpAppViewLease = {
  viewId: string;
  runtime: SessionMcpRuntime;
  sessionId: string;
  serverName: string;
  toolName: string;
  uiResourceUri: string;
  toolCallId?: string;
  html: string;
  csp?: McpAppCsp;
  permissions?: McpAppPermissions;
  allowedAppToolNames?: ReadonlySet<string>;
  authorizeAppInteraction?: () => boolean | Promise<boolean>;
  readOnly?: true;
  toolInput: unknown;
  toolResult: CallToolResult;
  expiresAtMs: number;
  requestWindowStartedAtMs: number;
  requestCount: number;
  toolCallCount: number;
  activeRequests: number;
  byteSize: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
  releaseRuntimeLease?: () => void;
};

export type McpAppChannelView = {
  viewId: string;
};

/** Retain only the bounded view identity needed for late channel materialization. */
export function readMcpAppChannelView(result: unknown): McpAppChannelView | undefined {
  const details = asRecord(asRecord(result)?.details);
  const preview = asRecord(details?.mcpAppPreview);
  const view = asRecord(preview?.view);
  const descriptor = asRecord(preview?.mcpApp);
  const viewId = typeof descriptor?.viewId === "string" ? descriptor.viewId.trim() : "";
  const projectedViewId = typeof view?.id === "string" ? view.id.trim() : "";
  if (!viewId || projectedViewId !== viewId) {
    return undefined;
  }
  return { viewId };
}

type McpAppViewStore = Map<string, McpAppViewLease>;

function getViewStore(): McpAppViewStore {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[MCP_APP_VIEW_STORE_KEY] as McpAppViewStore | undefined;
  if (existing) {
    return existing;
  }
  const store = new Map<string, McpAppViewLease>();
  globalStore[MCP_APP_VIEW_STORE_KEY] = store;
  return store;
}

function deleteView(viewId: string, expected?: McpAppViewLease): void {
  const store = getViewStore();
  const view = store.get(viewId);
  if (!view || (expected && view !== expected)) {
    return;
  }
  clearTimeout(view.expiryTimer);
  clearMcpAppModelContextForView(view.runtime, view);
  view.releaseRuntimeLease?.();
  store.delete(viewId);
  void completeDeferredSessionMcpRuntimeRetirement(view.runtime).catch((error: unknown) => {
    logWarn(`mcp-app: deferred runtime cleanup failed: ${formatErrorMessage(error)}`);
  });
}

function pruneViewStore(
  additionalBytes = 0,
  options?: { reserveEntry?: boolean; nowMs?: number },
): void {
  const store = getViewStore();
  const nowMs = options?.nowMs ?? Date.now();
  for (const [viewId, view] of store) {
    if (view.expiresAtMs <= nowMs) {
      deleteView(viewId, view);
    }
  }
  let totalBytes = Array.from(store.values()).reduce((sum, view) => sum + (view.byteSize ?? 0), 0);
  while (
    store.size + (options?.reserveEntry ? 1 : 0) > MCP_APP_VIEW_MAX_ENTRIES ||
    totalBytes + additionalBytes > MCP_APP_VIEW_STORE_MAX_BYTES
  ) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    const evicted = store.get(oldest);
    totalBytes -= evicted?.byteSize ?? 0;
    if (evicted) {
      deleteView(oldest, evicted);
    }
  }
}

function measureViewBytes(html: string, toolInput: unknown, toolResult: CallToolResult): number {
  const toolData = JSON.stringify({ toolInput, toolResult });
  const byteSize = Buffer.byteLength(html, "utf8") + Buffer.byteLength(toolData, "utf8");
  if (byteSize > MCP_APP_VIEW_MAX_BYTES) {
    throw new Error(`MCP App view data exceeds ${MCP_APP_VIEW_MAX_BYTES} bytes`);
  }
  return byteSize;
}

function assertBoundedViewDescriptor(value: {
  viewId?: string;
  serverName: string;
  toolName: string;
  uiResourceUri: string;
  toolCallId?: string;
}): void {
  if (
    (value.viewId && (value.viewId.length > 128 || !value.viewId.startsWith("mcp-app-"))) ||
    !value.serverName ||
    value.serverName.length > 256 ||
    !value.toolName ||
    value.toolName.length > 256 ||
    !value.uiResourceUri.startsWith("ui://") ||
    value.uiResourceUri.length > 2_048 ||
    (value.toolCallId !== undefined && value.toolCallId.length > 512)
  ) {
    throw new Error("MCP App preview descriptor exceeds safe limits");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizePermissions(value: unknown): McpAppPermissions | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const permissions: McpAppPermissions = {};
  for (const key of ["camera", "clipboardWrite", "geolocation", "microphone"] as const) {
    if (asRecord(record[key])) {
      permissions[key] = {};
    }
  }
  return Object.keys(permissions).length > 0 ? permissions : undefined;
}

function decodeResourceHtml(content: Record<string, unknown>): string {
  if (typeof content.text === "string") {
    if (Buffer.byteLength(content.text, "utf8") > MCP_APP_RESOURCE_MAX_BYTES) {
      throw new Error(`MCP App resource exceeds ${MCP_APP_RESOURCE_MAX_BYTES} bytes`);
    }
    return content.text;
  }
  if (typeof content.blob !== "string") {
    throw new Error("MCP App resource must provide text or base64 blob content");
  }
  const maxEncodedBytes = Math.ceil(MCP_APP_RESOURCE_MAX_BYTES / 3) * 4 + 4;
  if (content.blob.length > maxEncodedBytes) {
    throw new Error(`MCP App resource exceeds ${MCP_APP_RESOURCE_MAX_BYTES} bytes`);
  }
  const decoded = Buffer.from(content.blob, "base64");
  if (decoded.byteLength > MCP_APP_RESOURCE_MAX_BYTES) {
    throw new Error(`MCP App resource exceeds ${MCP_APP_RESOURCE_MAX_BYTES} bytes`);
  }
  return decoded.toString("utf8");
}

async function resolveListingUiMeta(
  runtime: SessionMcpRuntime,
  serverName: string,
  uri: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const listed = await runtime.listResources?.(serverName, { failureBackoff: "ignore" });
    const resources = Array.isArray(listed)
      ? listed
      : Array.isArray(asRecord(listed)?.resources)
        ? (asRecord(listed)?.resources as unknown[])
        : [];
    const resource = resources.map(asRecord).find((entry) => entry?.uri === uri);
    const { _meta: metadata } = resource ?? {};
    return asRecord(asRecord(metadata)?.ui);
  } catch (error) {
    // UI resources may be omitted from resources/list. Listing metadata is only
    // a fallback, so its failure must not discard valid resources/read content.
    logWarn(
      `mcp-app: failed to read optional listing metadata for ${uri} from "${serverName}": ${formatErrorMessage(error)}`,
    );
    return undefined;
  }
}

export async function fetchMcpAppView(params: {
  runtime: SessionMcpRuntime;
  serverName: string;
  toolName: string;
  uiResourceUri: string;
  toolCallId?: string;
  toolInput: unknown;
  toolResult: CallToolResult;
  allowedAppToolNames?: ReadonlySet<string>;
  authorizeAppInteraction?: () => boolean | Promise<boolean>;
  readOnly?: true;
  viewId?: string;
}): Promise<
  | {
      viewId: string;
      title: string;
      serverName: string;
      toolName: string;
      uiResourceUri: string;
      toolCallId?: string;
    }
  | undefined
> {
  let releaseRuntimeLease: (() => void) | undefined;
  try {
    assertBoundedViewDescriptor(params);
    if (!params.runtime.readResource || !params.uiResourceUri.startsWith("ui://")) {
      return undefined;
    }
    const result = asRecord(
      await params.runtime.readResource(params.serverName, params.uiResourceUri, {
        failureBackoff: "ignore",
      }),
    );
    const contents = Array.isArray(result?.contents) ? result.contents : [];
    if (contents.length !== 1) {
      throw new Error(`expected one MCP App resource, received ${contents.length}`);
    }
    const content = asRecord(contents[0]);
    if (!content || content.mimeType !== MCP_APP_RESOURCE_MIME_TYPE) {
      throw new Error(`resource must use ${MCP_APP_RESOURCE_MIME_TYPE}`);
    }
    const html = decodeResourceHtml(content);
    const byteSize = measureViewBytes(html, params.toolInput, params.toolResult);
    const { _meta: metadata, meta: deprecatedMetadata } = content;
    const contentUiMeta = asRecord(asRecord(metadata ?? deprecatedMetadata)?.ui);
    const listingUiMeta = contentUiMeta
      ? undefined
      : await resolveListingUiMeta(params.runtime, params.serverName, params.uiResourceUri);
    const uiMeta = contentUiMeta ?? listingUiMeta;
    const csp = normalizeMcpAppCsp(uiMeta?.csp);
    const permissions = normalizePermissions(uiMeta?.permissions);
    const title = `${params.toolName} UI`;
    const viewId = params.viewId ?? `mcp-app-${randomUUID()}`;
    releaseRuntimeLease = params.runtime.acquireLease?.();
    deleteView(viewId);
    pruneViewStore(byteSize, { reserveEntry: true });
    const view: McpAppViewLease = {
      viewId,
      runtime: params.runtime,
      sessionId: params.runtime.sessionId,
      serverName: params.serverName,
      toolName: params.toolName,
      uiResourceUri: params.uiResourceUri,
      ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
      html,
      ...(csp ? { csp } : {}),
      ...(permissions ? { permissions } : {}),
      ...(params.allowedAppToolNames
        ? { allowedAppToolNames: new Set(params.allowedAppToolNames) }
        : {}),
      ...(params.authorizeAppInteraction
        ? { authorizeAppInteraction: params.authorizeAppInteraction }
        : {}),
      ...(params.readOnly ? { readOnly: true as const } : {}),
      toolInput: params.toolInput,
      toolResult: params.toolResult,
      expiresAtMs: Date.now() + MCP_APP_VIEW_TTL_MS,
      requestWindowStartedAtMs: Date.now(),
      requestCount: 0,
      toolCallCount: 0,
      activeRequests: 0,
      byteSize,
      ...(releaseRuntimeLease ? { releaseRuntimeLease } : {}),
    };
    releaseRuntimeLease = undefined;
    view.expiryTimer = setTimeout(() => {
      deleteView(view.viewId, view);
    }, MCP_APP_VIEW_TTL_MS);
    view.expiryTimer.unref?.();
    getViewStore().set(viewId, view);
    return {
      viewId,
      title,
      serverName: params.serverName,
      toolName: params.toolName,
      uiResourceUri: params.uiResourceUri,
      ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
    };
  } catch (error) {
    releaseRuntimeLease?.();
    logWarn(
      `mcp-app: failed to prepare ${params.uiResourceUri} from "${params.serverName}": ${formatErrorMessage(error)}`,
    );
    return undefined;
  }
}

export function getMcpAppViewLease(
  viewId: string,
  runtime: SessionMcpRuntime,
): McpAppViewLease | undefined {
  pruneViewStore();
  const view = getViewStore().get(viewId);
  return view?.runtime === runtime ? view : undefined;
}

/** Resolve a live view owned by its originating session, including harness-native runtimes. */
export function getMcpAppViewLeaseForSession(
  viewId: string,
  sessionKey: string,
): McpAppViewLease | undefined {
  pruneViewStore();
  const view = getViewStore().get(viewId);
  return view?.runtime.sessionKey === sessionKey ? view : undefined;
}

export function acquireMcpAppViewRequest(
  view: McpAppViewLease,
  kind: "read" | "tool",
  nowMs = Date.now(),
): () => void {
  if (nowMs - view.requestWindowStartedAtMs >= 60_000) {
    view.requestWindowStartedAtMs = nowMs;
    view.requestCount = 0;
    view.toolCallCount = 0;
  }
  if (view.activeRequests >= 4) {
    throw new Error("MCP App request concurrency limit reached");
  }
  if (view.requestCount >= 120 || (kind === "tool" && view.toolCallCount >= 30)) {
    throw new Error("MCP App request rate limit reached");
  }
  view.requestCount += 1;
  if (kind === "tool") {
    view.toolCallCount += 1;
  }
  view.activeRequests += 1;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      view.activeRequests = Math.max(0, view.activeRequests - 1);
    }
  };
}

export function buildMcpAppCanvasPayload(view: {
  viewId: string;
  title: string;
  serverName: string;
  toolName: string;
  uiResourceUri: string;
  toolCallId?: string;
  originSessionKey?: string;
  resultMetaState?: "unavailable";
}) {
  assertBoundedViewDescriptor(view);
  return {
    kind: "canvas",
    view: { id: view.viewId, title: view.title },
    presentation: {
      target: "assistant_message",
      title: view.title,
      preferred_height: 600,
      sandbox: "scripts",
    },
    mcpApp: {
      viewId: view.viewId,
      serverName: view.serverName,
      toolName: view.toolName,
      uiResourceUri: view.uiResourceUri,
      ...(view.toolCallId ? { toolCallId: view.toolCallId } : {}),
      ...(view.originSessionKey ? { originSessionKey: view.originSessionKey } : {}),
      ...(view.resultMetaState ? { resultMetaState: view.resultMetaState } : {}),
    },
  };
}

const testing = {
  clearViewStore() {
    for (const [viewId, view] of getViewStore()) {
      deleteView(viewId, view);
    }
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.mcpUiResourceTestApi")] =
    testing;
}
