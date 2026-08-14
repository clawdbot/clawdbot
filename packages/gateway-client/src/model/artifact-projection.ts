import {
  normalizeUiArtifact,
  type UiArtifact,
  type UiArtifactValidationBounds,
  type UiArtifactViewOffer,
} from "@openclaw/gateway-protocol";

export type ControlModelArtifactProjectionBounds = UiArtifactValidationBounds &
  Readonly<{ maxArtifacts: number }>;

export type ControlModelArtifactSourceContext = Readonly<{
  sessionKey: string;
  messageId?: string;
  messageSequence?: number;
  toolCallId?: string;
  toolName?: string;
  live?: boolean;
}>;

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  // SAFETY: the runtime checks exclude null and arrays before property access.
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function artifactsIn(value: unknown, maxArtifacts: number): unknown[] {
  const candidate = record(value);
  if (!candidate) {
    return [];
  }
  return Array.isArray(candidate.uiArtifacts) ? candidate.uiArtifacts.slice(0, maxArtifacts) : [];
}

function failedArtifact(
  context: ControlModelArtifactSourceContext,
  error: Readonly<{ code: string; message: string; artifactId?: string; revision?: number }>,
): UiArtifact | null {
  if (!error.artifactId || error.revision === undefined) {
    return null;
  }
  return {
    version: 1,
    id: error.artifactId,
    revision: error.revision,
    views: [],
    state: "failed",
    source: {
      sessionKey: context.sessionKey,
      ...(context.messageId ? { messageId: context.messageId } : {}),
      ...(context.toolCallId && context.toolCallId !== "unknown"
        ? { toolCallId: context.toolCallId }
        : {}),
      ...(context.toolName ? { toolName: context.toolName } : {}),
    },
    error: { code: error.code, message: error.message },
  };
}

function normalizeCandidate(
  value: unknown,
  context: ControlModelArtifactSourceContext,
  bounds: ControlModelArtifactProjectionBounds,
): UiArtifact | null {
  const normalized = normalizeUiArtifact(value, bounds);
  if (!normalized.ok) {
    return failedArtifact(context, normalized.error);
  }
  if (normalized.value.source.sessionKey !== context.sessionKey) {
    return failedArtifact(context, {
      code: "ARTIFACT_SOURCE_MISMATCH",
      message: "UI artifact source does not match the selected conversation",
      artifactId: normalized.value.id,
      revision: normalized.value.revision,
    });
  }
  return {
    ...normalized.value,
    source: {
      sessionKey: context.sessionKey,
      ...(context.messageId ? { messageId: context.messageId } : {}),
      ...(context.toolCallId && context.toolCallId !== "unknown"
        ? { toolCallId: context.toolCallId }
        : {}),
      ...(context.toolName ? { toolName: context.toolName } : {}),
    },
  };
}

function mcpAppArtifact(
  detailsValue: unknown,
  context: ControlModelArtifactSourceContext,
  bounds: ControlModelArtifactProjectionBounds,
): UiArtifact | null {
  const details = record(detailsValue);
  const preview = record(details?.mcpAppPreview);
  const descriptor = record(preview?.mcpApp);
  const view = record(preview?.view);
  const viewId = text(descriptor?.viewId) ?? text(view?.id);
  const normalizedViewId = viewId ?? text(preview?.viewId);
  const uiResourceUri = text(descriptor?.uiResourceUri);
  const toolCallId = text(descriptor?.toolCallId) ?? context.toolCallId;
  if (!normalizedViewId || !uiResourceUri || !toolCallId) {
    return null;
  }
  const structuredContent = details?.structuredContent;
  const hasStructuredContent = structuredContent !== undefined;
  const fallbackAvailable = context.live === true || descriptor?.resultMetaState !== "unavailable";
  return normalizeCandidate(
    {
      version: 1,
      id: `mcp-app:${toolCallId}`,
      revision: context.messageSequence ?? 0,
      ...(hasStructuredContent ? { structuredContent } : {}),
      views: [
        {
          id: normalizedViewId,
          templateUri: uiResourceUri,
          dataVersion: 1,
          availability: hasStructuredContent ? "inline" : "deferred",
          ...(hasStructuredContent ? { data: structuredContent } : {}),
          ...(fallbackAvailable
            ? {
                fallback: {
                  kind: "mcp-app",
                  viewId: normalizedViewId,
                  uiResourceUri,
                },
              }
            : {}),
        },
      ],
      state: "ready",
      source: {
        sessionKey: context.sessionKey,
        ...(context.messageId ? { messageId: context.messageId } : {}),
        toolCallId,
        ...(context.toolName ? { toolName: context.toolName } : {}),
      },
    },
    context,
    bounds,
  );
}

function canvasArtifact(
  previewValue: unknown,
  context: ControlModelArtifactSourceContext,
  bounds: ControlModelArtifactProjectionBounds,
): UiArtifact | null {
  const preview = record(previewValue);
  if (preview?.kind !== "canvas") {
    return null;
  }
  const view = record(preview.view);
  const presentation = record(preview.presentation);
  const url = text(view?.url) ?? text(view?.entryUrl) ?? text(preview.url);
  const viewId = text(view?.id) ?? text(view?.docId) ?? text(preview.viewId);
  const sourceId = viewId ?? context.messageId;
  if (!url || !sourceId) {
    return null;
  }
  const requestedSandbox = presentation?.sandbox ?? preview.sandbox;
  const sandbox =
    requestedSandbox === "scripts" || requestedSandbox === "strict" ? requestedSandbox : "strict";
  return normalizeCandidate(
    {
      version: 1,
      id: `canvas:${sourceId}`,
      revision: context.messageSequence ?? 0,
      views: [
        {
          id: viewId ?? "canvas",
          templateUri: `openclaw://canvas/${encodeURIComponent(sourceId)}`,
          dataVersion: 1,
          availability: "deferred",
          fallback: {
            kind: "canvas",
            ...(viewId ? { viewId } : {}),
            url,
            sandbox,
          },
        },
      ],
      state: "ready",
      source: {
        sessionKey: context.sessionKey,
        ...(context.messageId ? { messageId: context.messageId } : {}),
        ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
        ...(context.toolName ? { toolName: context.toolName } : {}),
      },
    },
    context,
    bounds,
  );
}

function collectDetails(
  details: unknown,
  context: ControlModelArtifactSourceContext,
  bounds: ControlModelArtifactProjectionBounds,
  maxCandidates: number,
): UiArtifact[] {
  const result: UiArtifact[] = [];
  for (const value of artifactsIn(details, maxCandidates)) {
    const normalized = normalizeCandidate(value, context, bounds);
    if (normalized) {
      result.push(normalized);
    }
  }
  let mcp: UiArtifact | null = null;
  if (result.length < maxCandidates) {
    mcp = mcpAppArtifact(details, context, bounds);
    if (mcp) {
      result.push(mcp);
    }
  }
  if (result.length < maxCandidates) {
    const preview = record(details)?.mcpAppPreview;
    const canvas = canvasArtifact(preview, context, bounds);
    if (canvas && !mcp) {
      result.push(canvas);
    }
  }
  return result;
}

export function collectMessageUiArtifacts(
  messageValue: unknown,
  context: ControlModelArtifactSourceContext,
  bounds: ControlModelArtifactProjectionBounds,
  maxCandidates = bounds.maxArtifacts + 1,
): UiArtifact[] {
  const message = record(messageValue);
  if (!message) {
    return [];
  }
  const messageContext = {
    ...context,
    toolCallId:
      context.toolCallId ?? text(message.toolCallId) ?? text(message.tool_call_id) ?? undefined,
    toolName: context.toolName ?? text(message.toolName) ?? text(message.tool_name) ?? undefined,
  };
  const result = collectDetails(message.details, messageContext, bounds, maxCandidates);
  for (const blockValue of Array.isArray(message.content) ? message.content : []) {
    if (result.length >= maxCandidates) {
      break;
    }
    const block = record(blockValue);
    if (!block) {
      continue;
    }
    result.push(
      ...collectDetails(block.details, messageContext, bounds, maxCandidates - result.length),
    );
    if (block.type === "ui_artifact" && result.length < maxCandidates) {
      const normalized = normalizeCandidate(block.artifact, messageContext, bounds);
      if (normalized) {
        result.push(normalized);
      }
    }
    if (block.type === "canvas" && result.length < maxCandidates) {
      const mcp = mcpAppArtifact({ mcpAppPreview: block.preview }, messageContext, bounds);
      if (mcp) {
        result.push(mcp);
      }
      const canvas = canvasArtifact(block.preview, messageContext, bounds);
      if (canvas && !mcp && result.length < maxCandidates) {
        result.push(canvas);
      }
    }
  }
  return result;
}

export function collectToolEventUiArtifacts(
  dataValue: unknown,
  context: ControlModelArtifactSourceContext,
  bounds: ControlModelArtifactProjectionBounds,
  maxCandidates = bounds.maxArtifacts + 1,
): UiArtifact[] {
  const data = record(dataValue);
  if (!data) {
    return [];
  }
  const candidates = [
    data,
    record(data.output),
    record(data.result),
    record(data.partialResult),
    record(record(data.output)?.details),
    record(record(data.result)?.details),
    record(record(data.partialResult)?.details),
  ];
  const result: UiArtifact[] = [];
  for (const candidate of candidates) {
    if (!candidate || result.length >= maxCandidates) {
      continue;
    }
    result.push(...collectDetails(candidate, context, bounds, maxCandidates - result.length));
  }
  return result;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  // SAFETY: primitive and array values returned above, leaving an object record.
  return `{${Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function reconcileOne(current: UiArtifact | undefined, incoming: UiArtifact): UiArtifact {
  if (!current || incoming.revision > current.revision) {
    return incoming;
  }
  if (incoming.revision < current.revision) {
    return current;
  }
  const currentContent = {
    structuredContent: current.structuredContent,
    views: current.views,
    state: current.state,
    error: current.error,
  };
  const incomingContent = {
    structuredContent: incoming.structuredContent,
    views: incoming.views,
    state: incoming.state,
    error: incoming.error,
  };
  if (stableStringify(currentContent) === stableStringify(incomingContent)) {
    const preferIncomingSource = Boolean(incoming.source.messageId && !current.source.messageId);
    return {
      ...current,
      source: preferIncomingSource
        ? { ...current.source, ...incoming.source }
        : { ...incoming.source, ...current.source },
    };
  }
  if (current.error?.code === "ARTIFACT_REVISION_CONFLICT") {
    return current;
  }
  return {
    ...current,
    state: "failed",
    error: {
      code: "ARTIFACT_REVISION_CONFLICT",
      message: "Conflicting UI artifact content was received for the current revision",
    },
  };
}

export function reconcileUiArtifacts(
  candidates: readonly UiArtifact[],
  bounds: ControlModelArtifactProjectionBounds,
): UiArtifact[] {
  const artifacts = new Map<string, UiArtifact>();
  for (const artifact of candidates) {
    artifacts.set(artifact.id, reconcileOne(artifacts.get(artifact.id), artifact));
  }
  const retained = [...artifacts.values()].toSorted(
    (left, right) => left.revision - right.revision || left.id.localeCompare(right.id),
  );
  return retained.length > bounds.maxArtifacts ? retained.slice(-bounds.maxArtifacts) : retained;
}

export function materializedViewKey(
  artifactId: string,
  artifactRevision: number,
  viewId: string,
): string {
  return JSON.stringify([artifactId, artifactRevision, viewId]);
}

export function applyMaterializedUiArtifactViews(
  artifacts: readonly UiArtifact[],
  materialized: ReadonlyMap<string, UiArtifactViewOffer>,
): UiArtifact[] {
  return artifacts.map((artifact) => {
    let changed = false;
    const views = artifact.views.map((view) => {
      const replacement = materialized.get(
        materializedViewKey(artifact.id, artifact.revision, view.id),
      );
      if (!replacement) {
        return view;
      }
      changed = true;
      return replacement;
    });
    return changed ? { ...artifact, views } : artifact;
  });
}
