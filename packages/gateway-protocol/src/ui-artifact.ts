export type UiArtifactJsonValue =
  | null
  | boolean
  | number
  | string
  | UiArtifactJsonValue[]
  | { [key: string]: UiArtifactJsonValue };

export type UiArtifactFallback =
  | Readonly<{
      kind: "mcp-app";
      viewId: string;
      uiResourceUri?: string;
    }>
  | Readonly<{
      kind: "canvas";
      viewId?: string;
      url: string;
      sandbox: "strict" | "scripts";
    }>;

export type UiArtifactViewOffer = Readonly<{
  id: string;
  templateUri: string;
  dataVersion: number;
  availability: "inline" | "deferred";
  data?: UiArtifactJsonValue;
  recommended?: boolean;
  fallback?: UiArtifactFallback;
}>;

export type UiArtifactSource = Readonly<{
  sessionKey: string;
  messageId?: string;
  toolCallId?: string;
  toolName?: string;
}>;

export type UiArtifactError = Readonly<{
  code: string;
  message: string;
}>;

export type UiArtifact = Readonly<{
  version: 1;
  id: string;
  revision: number;
  structuredContent?: UiArtifactJsonValue;
  views: readonly UiArtifactViewOffer[];
  state: "pending" | "ready" | "failed" | "expired";
  source: UiArtifactSource;
  error?: UiArtifactError;
}>;

export type UiArtifactValidationBounds = Readonly<{
  maxBytes: number;
  maxDepth: number;
  maxCollectionItems: number;
  maxStringBytes: number;
  maxViews: number;
}>;

export type UiArtifactValidationError = Readonly<{
  code: "ARTIFACT_MALFORMED" | "ARTIFACT_OVERSIZED" | "ARTIFACT_UNSUPPORTED_VERSION";
  message: string;
  artifactId?: string;
  revision?: number;
}>;

export type UiArtifactValidationResult =
  | Readonly<{ ok: true; value: UiArtifact }>
  | Readonly<{ ok: false; error: UiArtifactValidationError }>;

export const DEFAULT_UI_ARTIFACT_VALIDATION_BOUNDS: UiArtifactValidationBounds = Object.freeze({
  maxBytes: 64_000,
  maxDepth: 12,
  maxCollectionItems: 256,
  maxStringBytes: 16_000,
  maxViews: 16,
});

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  // SAFETY: the runtime checks exclude null and arrays before property access.
  return value as Record<string, unknown>;
}

function text(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized && encodedBytes(normalized) <= maxBytes ? normalized : null;
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function absoluteUri(input: unknown, maxBytes: number): string | null {
  const uri = text(input, maxBytes);
  if (!uri) {
    return null;
  }
  try {
    return new URL(uri).protocol ? uri : null;
  } catch {
    return null;
  }
}

function canvasUrl(input: unknown): string | null {
  const url = text(input, 2_048);
  return url && (url.startsWith("/") || absoluteUri(url, 2_048)) ? url : null;
}

function normalizeJson(
  value: unknown,
  bounds: UiArtifactValidationBounds,
  depth = 0,
  seen = new WeakSet<object>(),
): UiArtifactJsonValue | undefined {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    return encodedBytes(value) <= bounds.maxStringBytes ? value : undefined;
  }
  if (typeof value !== "object" || seen.has(value) || depth >= bounds.maxDepth) {
    return undefined;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > bounds.maxCollectionItems) {
      return undefined;
    }
    const result: UiArtifactJsonValue[] = [];
    for (const item of value) {
      const normalized = normalizeJson(item, bounds, depth + 1, seen);
      if (normalized === undefined) {
        return undefined;
      }
      result.push(normalized);
    }
    seen.delete(value);
    return result;
  }
  // SAFETY: primitive and array values returned above, leaving an object record.
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > bounds.maxCollectionItems) {
    return undefined;
  }
  const result: Record<string, UiArtifactJsonValue> = {};
  for (const [key, item] of entries) {
    if (!key || encodedBytes(key) > bounds.maxStringBytes) {
      return undefined;
    }
    const normalized = normalizeJson(item, bounds, depth + 1, seen);
    if (normalized === undefined) {
      return undefined;
    }
    result[key] = normalized;
  }
  seen.delete(value);
  return result;
}

function normalizeFallback(value: unknown): UiArtifactFallback | undefined {
  const fallback = record(value);
  const kind = text(fallback?.kind, 32);
  if (kind === "mcp-app") {
    const viewId = text(fallback?.viewId, 128);
    const uiResourceUri =
      fallback?.uiResourceUri === undefined
        ? undefined
        : absoluteUri(fallback.uiResourceUri, 2_048);
    if (!viewId || (fallback?.uiResourceUri !== undefined && !uiResourceUri)) {
      return undefined;
    }
    return {
      kind,
      viewId,
      ...(uiResourceUri ? { uiResourceUri } : {}),
    };
  }
  if (kind === "canvas") {
    const viewId = fallback?.viewId === undefined ? undefined : text(fallback.viewId, 128);
    const url = canvasUrl(fallback?.url);
    const sandbox =
      fallback?.sandbox === "strict" || fallback?.sandbox === "scripts" ? fallback.sandbox : null;
    if (!url || !sandbox || (fallback?.viewId !== undefined && !viewId)) {
      return undefined;
    }
    return { kind, ...(viewId ? { viewId } : {}), url, sandbox };
  }
  return undefined;
}

function normalizeView(
  value: unknown,
  bounds: UiArtifactValidationBounds,
): UiArtifactViewOffer | undefined {
  const view = record(value);
  if (!view) {
    return undefined;
  }
  const id = text(view?.id, 128);
  const templateUri = absoluteUri(view?.templateUri, 2_048);
  const dataVersion = positiveInteger(view?.dataVersion);
  const availability =
    view?.availability === "inline" || view?.availability === "deferred" ? view.availability : null;
  if (!id || !templateUri || dataVersion === null || !availability) {
    return undefined;
  }
  const hasData = Object.hasOwn(view, "data");
  const data = hasData ? normalizeJson(view.data, bounds) : undefined;
  if (
    (availability === "inline" && data === undefined) ||
    (availability === "deferred" && hasData)
  ) {
    return undefined;
  }
  const fallback = view?.fallback === undefined ? undefined : normalizeFallback(view.fallback);
  if (view?.fallback !== undefined && !fallback) {
    return undefined;
  }
  return {
    id,
    templateUri,
    dataVersion,
    availability,
    ...(data !== undefined ? { data } : {}),
    ...(view?.recommended === true ? { recommended: true } : {}),
    ...(fallback ? { fallback } : {}),
  };
}

function malformed(
  message: string,
  artifactId?: string,
  revision?: number,
): UiArtifactValidationResult {
  return {
    ok: false,
    error: {
      code: "ARTIFACT_MALFORMED",
      message,
      ...(artifactId ? { artifactId } : {}),
      ...(revision !== undefined ? { revision } : {}),
    },
  };
}

export function normalizeUiArtifact(
  value: unknown,
  bounds: UiArtifactValidationBounds = DEFAULT_UI_ARTIFACT_VALIDATION_BOUNDS,
): UiArtifactValidationResult {
  const artifact = record(value);
  const id = text(artifact?.id, 256) ?? undefined;
  const revision = nonnegativeInteger(artifact?.revision) ?? undefined;
  if (artifact?.version !== 1) {
    return {
      ok: false,
      error: {
        code: "ARTIFACT_UNSUPPORTED_VERSION",
        message: "Unsupported UI artifact version",
        ...(id ? { artifactId: id } : {}),
        ...(revision !== undefined ? { revision } : {}),
      },
    };
  }
  const state =
    artifact?.state === "pending" ||
    artifact?.state === "ready" ||
    artifact?.state === "failed" ||
    artifact?.state === "expired"
      ? artifact.state
      : null;
  const source = record(artifact?.source);
  const sessionKey = text(source?.sessionKey, 512);
  if (!id || revision === undefined || !state || !source || !sessionKey) {
    return malformed("UI artifact identity, state, or source is malformed", id, revision);
  }
  if (!Array.isArray(artifact?.views) || artifact.views.length > bounds.maxViews) {
    return malformed("UI artifact views are malformed", id, revision);
  }
  const views: UiArtifactViewOffer[] = [];
  const viewIds = new Set<string>();
  for (const rawView of artifact.views) {
    const view = normalizeView(rawView, bounds);
    if (!view || viewIds.has(view.id)) {
      return malformed("UI artifact contains an invalid or duplicate view", id, revision);
    }
    viewIds.add(view.id);
    views.push(view);
  }
  const structuredContent =
    artifact.structuredContent === undefined
      ? undefined
      : normalizeJson(artifact.structuredContent, bounds);
  if (artifact.structuredContent !== undefined && structuredContent === undefined) {
    return malformed("UI artifact structured content is malformed", id, revision);
  }
  const messageId =
    source.messageId === undefined ? undefined : (text(source.messageId, 512) ?? undefined);
  const toolCallId =
    source.toolCallId === undefined ? undefined : (text(source.toolCallId, 512) ?? undefined);
  const toolName =
    source.toolName === undefined ? undefined : (text(source.toolName, 256) ?? undefined);
  if (
    (source.messageId !== undefined && !messageId) ||
    (source.toolCallId !== undefined && !toolCallId) ||
    (source.toolName !== undefined && !toolName)
  ) {
    return malformed("UI artifact source is malformed", id, revision);
  }
  const errorRecord = record(artifact.error);
  const error =
    errorRecord === null
      ? undefined
      : {
          code: text(errorRecord.code, 128),
          message: text(errorRecord.message, 1_024),
        };
  if (
    artifact.error !== undefined &&
    (!error?.code || !error.message || (state !== "failed" && state !== "expired"))
  ) {
    return malformed("UI artifact error is malformed", id, revision);
  }
  const normalized: UiArtifact = {
    version: 1,
    id,
    revision,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    views,
    state,
    source: {
      sessionKey,
      ...(messageId ? { messageId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolName ? { toolName } : {}),
    },
    ...(error?.code && error.message
      ? { error: { code: error.code, message: error.message } }
      : {}),
  };
  const encoded = JSON.stringify(normalized);
  if (encodedBytes(encoded) > bounds.maxBytes) {
    return {
      ok: false,
      error: {
        code: "ARTIFACT_OVERSIZED",
        message: "UI artifact exceeds the retained byte bound",
        artifactId: id,
        revision,
      },
    };
  }
  return { ok: true, value: normalized };
}
