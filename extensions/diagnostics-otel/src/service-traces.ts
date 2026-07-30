import {
  context as otelContextApi,
  trace,
  type SpanContext,
  type SpanKind,
  type Tracer,
} from "@opentelemetry/api";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticTraceContext,
} from "../api.js";
import { redactOtelAttributes } from "./service-attributes.js";
import { MAX_RETAINED_TRUSTED_SPAN_CONTEXTS } from "./service-constants.js";
import {
  contextForTraceContext,
  normalizedTrustedTraceContext,
  normalizeTraceContext,
} from "./service-trace-context.js";
import type { TrustedSpanAliasOwner } from "./service-types.js";

export function createDiagnosticsTraceRuntime(tracer: Tracer) {
  const activeTrustedSpans = new Map<string, ReturnType<typeof tracer.startSpan>>();
  const activeTrustedSpanAliases = new Map<
    string,
    { span: ReturnType<typeof tracer.startSpan>; spanId: string; owner: TrustedSpanAliasOwner }
  >();
  // Translates a completed lifecycle span's diagnostic span id to the real OTel
  // span context so late children still attach to the span we exported. Kept for
  // the service lifetime, bounded by MAX_RETAINED_TRUSTED_SPAN_CONTEXTS: children
  // of a long turn arrive on later ticks, so any elapsed-time eviction silently
  // reparents them into brand-new single-span traces.
  const retainedTrustedSpanContexts = new Map<
    string,
    { spanContext: SpanContext; owner?: TrustedSpanAliasOwner }
  >();
  const stopActiveTrustedSpans = () => {
    const stopAt = Date.now();
    retainedTrustedSpanContexts.clear();
    for (const span of new Set([
      ...activeTrustedSpans.values(),
      ...Array.from(activeTrustedSpanAliases.values(), (entry) => entry.span),
    ])) {
      span.end(stopAt);
    }
    activeTrustedSpans.clear();
    activeTrustedSpanAliases.clear();
  };
  const spanWithDuration = (
    name: string,
    attributes: Record<string, string | number | boolean>,
    durationMs?: number,
    options: {
      parentContext?: ReturnType<typeof contextForTraceContext> | null;
      endTimeMs?: number;
      kind?: SpanKind;
      startTimeMs?: number;
    } = {},
  ) => {
    const endTimeMs = options.endTimeMs ?? Date.now();
    const startTime =
      typeof options.startTimeMs === "number"
        ? options.startTimeMs
        : typeof durationMs === "number" && durationMs >= 0
          ? endTimeMs - durationMs
          : undefined;
    const parentContext =
      "parentContext" in options ? (options.parentContext ?? undefined) : undefined;
    const span = tracer.startSpan(
      name,
      {
        attributes: redactOtelAttributes(attributes),
        ...(options.kind !== undefined ? { kind: options.kind } : {}),
        ...(startTime !== undefined ? { startTime } : {}),
      },
      parentContext,
    );
    return span;
  };
  const trustedTraceContext = (evt: DiagnosticEventPayload, metadata: DiagnosticEventMetadata) =>
    metadata.trusted ? normalizeTraceContext(evt.trace) : undefined;
  // Internal-dispatcher events are linkable on their own; everything else defers to
  // the shared trusted-trace-context rule, which also accepts an untrusted payload
  // whose trace context came from OpenClaw-owned scope (metadata.trustedTraceContext).
  const internalOrTrustedTraceContext = (
    evt: DiagnosticEventPayload,
    metadata: DiagnosticEventMetadata,
  ) =>
    metadata.internal
      ? normalizeTraceContext(evt.trace)
      : normalizedTrustedTraceContext(evt, metadata);
  const trustedSpanAliasOwner = (
    evt: DiagnosticEventPayload,
  ): TrustedSpanAliasOwner | undefined => {
    if ("runId" in evt && evt.runId) {
      return { kind: "run", id: evt.runId };
    }
    return undefined;
  };
  const sameTrustedSpanAliasOwner = (
    left: TrustedSpanAliasOwner | undefined,
    right: TrustedSpanAliasOwner | undefined,
  ) => Boolean(left && right && left.kind === right.kind && left.id === right.id);
  const trustedSpanAliasKey = (spanId: string, owner: TrustedSpanAliasOwner) =>
    `${spanId}:${owner.kind}:${owner.id}`;
  const retainedTrustedSpanContextKey = (
    traceId: string,
    spanId: string,
    owner?: TrustedSpanAliasOwner,
  ) => `${traceId}:${owner ? trustedSpanAliasKey(spanId, owner) : spanId}`;
  const retainedTrustedSpanContext = (
    traceContext: DiagnosticTraceContext | undefined,
    spanId: string | undefined,
    owner?: TrustedSpanAliasOwner,
  ) => {
    if (!traceContext?.traceId || !spanId) {
      return undefined;
    }
    const retained =
      (owner
        ? retainedTrustedSpanContexts.get(
            retainedTrustedSpanContextKey(traceContext.traceId, spanId, owner),
          )
        : undefined) ??
      retainedTrustedSpanContexts.get(retainedTrustedSpanContextKey(traceContext.traceId, spanId));
    // Both sides key on the diagnostic trace id, so a hit is already trace-correct.
    // Re-comparing against the stored OTel SpanContext.traceId would wrongly reject
    // root lifecycle spans, whose OTel trace id is SDK-generated; spans parented from
    // an upstream traceparent do adopt the diagnostic trace id, so the two are equal
    // there and unequal here.
    if (!retained) {
      return undefined;
    }
    if (retained.owner && !sameTrustedSpanAliasOwner(retained.owner, owner)) {
      return undefined;
    }
    return retained.spanContext;
  };
  const activeTrustedSpanAlias = (spanId: string, owner: TrustedSpanAliasOwner | undefined) => {
    if (!owner) {
      return undefined;
    }
    const alias = activeTrustedSpanAliases.get(trustedSpanAliasKey(spanId, owner));
    if (!alias || !sameTrustedSpanAliasOwner(alias.owner, owner)) {
      return undefined;
    }
    return alias.span;
  };
  const internalOrTrustedParentContext = (
    evt: DiagnosticEventPayload,
    metadata: DiagnosticEventMetadata,
  ) => {
    const traceContext = internalOrTrustedTraceContext(evt, metadata);
    const parentSpanId = traceContext?.parentSpanId ?? traceContext?.spanId;
    if (!traceContext || !parentSpanId) {
      return undefined;
    }
    return contextForTraceContext({
      ...traceContext,
      spanId: parentSpanId,
    });
  };
  const internalOrTrustedExplicitParentContext = (
    evt: DiagnosticEventPayload,
    metadata: DiagnosticEventMetadata,
  ) => {
    const traceContext = internalOrTrustedTraceContext(evt, metadata);
    if (!traceContext?.parentSpanId) {
      return undefined;
    }
    return contextForTraceContext({
      ...traceContext,
      spanId: traceContext.parentSpanId,
    });
  };
  const activeTrustedParentContext = (
    evt: DiagnosticEventPayload,
    metadata: DiagnosticEventMetadata,
  ) => {
    const traceContext = trustedTraceContext(evt, metadata);
    const parentSpanId = traceContext?.parentSpanId;
    if (!parentSpanId) {
      return undefined;
    }
    const owner = trustedSpanAliasOwner(evt);
    const activeParentSpan =
      activeTrustedSpans.get(parentSpanId) ?? activeTrustedSpanAlias(parentSpanId, owner);
    const spanContext =
      activeParentSpan?.spanContext() ??
      retainedTrustedSpanContext(traceContext, parentSpanId, owner);
    if (!spanContext) {
      return undefined;
    }
    return trace.setSpanContext(otelContextApi.active(), spanContext);
  };
  const activeInternalOrTrustedContext = (
    evt: DiagnosticEventPayload,
    metadata: DiagnosticEventMetadata,
  ) => {
    const traceContext = internalOrTrustedTraceContext(evt, metadata);
    if (!traceContext) {
      return undefined;
    }
    const owner = trustedSpanAliasOwner(evt);
    const activeSpan =
      (traceContext.spanId
        ? (activeTrustedSpans.get(traceContext.spanId) ??
          activeTrustedSpanAlias(traceContext.spanId, owner))
        : undefined) ??
      (traceContext.parentSpanId
        ? (activeTrustedSpans.get(traceContext.parentSpanId) ??
          activeTrustedSpanAlias(traceContext.parentSpanId, owner))
        : undefined);
    if (activeSpan) {
      return trace.setSpanContext(otelContextApi.active(), activeSpan.spanContext());
    }
    const retainedSpanContext =
      retainedTrustedSpanContext(traceContext, traceContext.spanId, owner) ??
      retainedTrustedSpanContext(traceContext, traceContext.parentSpanId, owner);
    if (retainedSpanContext) {
      return trace.setSpanContext(otelContextApi.active(), retainedSpanContext);
    }
    return internalOrTrustedParentContext(evt, metadata);
  };
  const trackTrustedSpan = (
    evt: DiagnosticEventPayload,
    metadata: DiagnosticEventMetadata,
    span: ReturnType<typeof tracer.startSpan>,
  ) => {
    const spanId = trustedTraceContext(evt, metadata)?.spanId;
    if (spanId) {
      activeTrustedSpans.set(spanId, span);
    }
    return span;
  };
  const trackInternalOrTrustedSpan = (
    evt: DiagnosticEventPayload,
    metadata: DiagnosticEventMetadata,
    span: ReturnType<typeof tracer.startSpan>,
  ) => {
    const spanId = internalOrTrustedTraceContext(evt, metadata)?.spanId;
    if (spanId) {
      activeTrustedSpans.set(spanId, span);
    }
    return span;
  };
  const takeTrackedTrustedSpan = (
    evt: DiagnosticEventPayload,
    metadata: DiagnosticEventMetadata,
  ) => {
    const spanId = trustedTraceContext(evt, metadata)?.spanId;
    if (!spanId) {
      return undefined;
    }
    const span = activeTrustedSpans.get(spanId);
    if (span) {
      activeTrustedSpans.delete(spanId);
    }
    return span;
  };
  const getTrackedInternalOrTrustedSpan = (
    evt: DiagnosticEventPayload,
    metadata: DiagnosticEventMetadata,
  ) => {
    const spanId = internalOrTrustedTraceContext(evt, metadata)?.spanId;
    if (!spanId) {
      return undefined;
    }
    return activeTrustedSpans.get(spanId);
  };
  const setSpanAttrs = (
    span: ReturnType<typeof tracer.startSpan>,
    attributes: Record<string, string | number | boolean>,
  ) => {
    span.setAttributes?.(redactOtelAttributes(attributes));
  };
  const retainTrustedSpanContext = (
    traceId: string,
    spanId: string,
    spanContext: SpanContext,
    owner?: TrustedSpanAliasOwner,
  ) => {
    retainedTrustedSpanContexts.set(retainedTrustedSpanContextKey(traceId, spanId, owner), {
      spanContext,
      ...(owner ? { owner } : {}),
    });
    while (retainedTrustedSpanContexts.size > MAX_RETAINED_TRUSTED_SPAN_CONTEXTS) {
      const oldestKey = retainedTrustedSpanContexts.keys().next().value;
      if (!oldestKey) {
        break;
      }
      retainedTrustedSpanContexts.delete(oldestKey);
    }
  };
  // Takes the whole diagnostic trace context, not a bare trace id: later children
  // look the parent up by the ids they carry on their own event, and DiagnosticTraceContext
  // is the only shape that cannot be satisfied by an OTel SpanContext (traceFlags is
  // string here, number there). Passing span.spanContext() would key retention under
  // the OTel trace id and silently split every late child into its own trace.
  const completeTrackedLifecycleSpan = (
    traceContext: DiagnosticTraceContext,
    spanId: string,
    span: ReturnType<typeof tracer.startSpan>,
    endTimeMs: number,
  ) => {
    const spanContext = span.spanContext();
    const retainedKeys: Array<{ spanId: string; owner?: TrustedSpanAliasOwner }> = [{ spanId }];
    const retainedAliasKeys: string[] = [];
    for (const [aliasKey, alias] of activeTrustedSpanAliases) {
      if (alias.span === span) {
        retainedKeys.push({ spanId: alias.spanId, owner: alias.owner });
        retainedAliasKeys.push(aliasKey);
      }
    }
    if (activeTrustedSpans.get(spanId) === span) {
      activeTrustedSpans.delete(spanId);
    }
    for (const aliasKey of retainedAliasKeys) {
      if (activeTrustedSpanAliases.get(aliasKey)?.span === span) {
        activeTrustedSpanAliases.delete(aliasKey);
      }
    }
    span.end(endTimeMs);
    for (const retainedKey of retainedKeys) {
      retainTrustedSpanContext(
        traceContext.traceId,
        retainedKey.spanId,
        spanContext,
        retainedKey.owner,
      );
    }
  };

  const addRunAttrs = (
    spanAttrs: Record<string, string | number | boolean>,
    evt: {
      runId?: string;
      sessionKey?: string;
      sessionId?: string;
      provider?: string;
      model?: string;
      channel?: string;
      trigger?: string;
    },
  ) => {
    if (evt.provider) {
      spanAttrs["openclaw.provider"] = evt.provider;
    }
    if (evt.model) {
      spanAttrs["openclaw.model"] = evt.model;
    }
    if (evt.channel) {
      spanAttrs["openclaw.channel"] = evt.channel;
    }
    if (evt.trigger) {
      spanAttrs["openclaw.trigger"] = evt.trigger;
    }
  };

  const paramsSummaryAttrs = (
    summary: Extract<DiagnosticEventPayload, { type: "tool.execution.started" }>["paramsSummary"],
  ): Record<string, string | number> => {
    if (!summary) {
      return {};
    }
    return {
      "openclaw.tool.params.kind": summary.kind,
      ...("length" in summary ? { "openclaw.tool.params.length": summary.length } : {}),
    };
  };
  return {
    tracer,
    activeTrustedSpans,
    activeTrustedSpanAliases,
    trustedSpanAliasKey,
    trustedSpanAliasOwner,
    spanWithDuration,
    trustedTraceContext,
    internalOrTrustedTraceContext,
    internalOrTrustedParentContext,
    internalOrTrustedExplicitParentContext,
    activeTrustedParentContext,
    activeInternalOrTrustedContext,
    trackTrustedSpan,
    trackInternalOrTrustedSpan,
    takeTrackedTrustedSpan,
    getTrackedInternalOrTrustedSpan,
    setSpanAttrs,
    completeTrackedLifecycleSpan,
    addRunAttrs,
    paramsSummaryAttrs,
    stopActiveTrustedSpans,
  };
}

export type DiagnosticsTraceRuntime = ReturnType<typeof createDiagnosticsTraceRuntime>;
