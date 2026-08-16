// Continuation-tracer shim for chain-correlation spans.
//
// The thin tracer interface keeps span emission additive: callers that do not
// install an adapter see no behavior change, and diagnostics plugins can wire a
// concrete exporter without changing continuation call sites.

import { createHash } from "node:crypto";
import { redactToolPayloadText } from "../logging/redact.js";
import {
  formatDiagnosticTraceparent,
  getActiveDiagnosticTraceContext,
  normalizeDiagnosticTraceparent,
  parseDiagnosticTraceparent,
  type DiagnosticTraceContext,
} from "./diagnostic-trace-context.js";

/**
 * Span attribute values mirror the OTEL semantic-conventions primitive set:
 * string | number | boolean (and arrays thereof). We intentionally restrict
 * to scalars here — anything richer belongs in span events, not attributes.
 */
export type SpanAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

export type SpanAttributes = Readonly<Record<string, SpanAttributeValue>>;

/**
 * Canonical enumeration of all `signal.kind` attribute values emitted by continuation spans.
 *
 * SSOT for the value-space. Helper signatures, disabled-helper narrowing, and tests all
 * derive from this; do not re-enumerate inline.
 *
 * @see ContinuationSignalKind — derived union type
 * @see ContinuationDisabledSignalKind — Extract<>-narrowed subset for `continuation.disabled`
 */
export const CONTINUATION_SIGNAL_KINDS = [
  "work",
  "bracket-work",
  "bracket-delegate",
  "tool-delegate",
  "compaction-release",
  "heartbeat",
] as const;

/** Union type derived from {@link CONTINUATION_SIGNAL_KINDS}. */
export type ContinuationSignalKind = (typeof CONTINUATION_SIGNAL_KINDS)[number];

/**
 * Subset of {@link ContinuationSignalKind} that may appear on `continuation.disabled` spans.
 * Excludes `"work"` and `"compaction-release"` because those signal families
 * are never rejected by the disabled-span helper.
 */
export type ContinuationDisabledSignalKind = Extract<
  ContinuationSignalKind,
  "bracket-work" | "bracket-delegate" | "tool-delegate"
>;

/**
 * Normative attribute-key set for continuation spans.
 *
 * Pinning these names at the shim type, not at an adapter, catches drift at
 * compile-time. Without this pin, an adapter-side rename to `chain_id` or
 * `chainId` would surface only as a runtime trace mismatch.
 *
 * All keys are optional because not every span carries every attribute
 * (e.g. `heartbeat` carries `continuation.disabled` but no `delay.ms`).
 * The `Readonly<Record<string, SpanAttributeValue>>` superset on
 * `setAttributes` / `StartSpanOptions.attributes` permits diagnostic /
 * adapter-internal attributes that aren't part of the canonical contract;
 * `ContinuationSpanAttrs` is what the canonical-attribute-name tests assert
 * against.
 *
 * Mirror in tests at `continuation-tracer.test.ts ::
 * "canonical attribute names round-trip through the surface"`.
 */
export type ContinuationSpanAttrs = {
  /** Stable id for the continuation chain this span belongs to. */
  readonly "chain.id"?: string;
  /** Remaining chain-step budget, post-decrement at this span. */
  readonly "chain.step.remaining"?: number;
  /** Scheduled delay (ms) until the next-turn / delegate fires. */
  readonly "delay.ms"?: number;
  /** True when a reason/task text existed but raw preview text was intentionally omitted. */
  readonly "reason.present"?: boolean;
  /** Character length of the original reason/task text; raw text is never exported. */
  readonly "reason.length"?: number;
  /** Stable sha256-16 of the redacted reason/task text for correlation without raw text. */
  readonly "reason.hash"?: string;
  /** True when the shared tool-payload redactor changed the text before hashing. */
  readonly "reason.redacted"?: boolean;
  /** Mode of a `continue_delegate` dispatch (normal/silent/silent-wake/post-compaction). */
  readonly "delegate.mode"?: string;
  /**
   * Delivery shape of the delegate dispatch — `"immediate"` when no
   * delay was requested (or delay was 0), `"timer"` when `setTimeout`
   * armed for a non-zero clamped delay. Distinct from `delegate.mode`
   * (which captures *intent*: normal/silent/silent-wake/post-compaction).
   * Threaded so `continuation.disabled` reject spans can
   * distinguish cap-rejected-immediate (no timer ever armed) from
   * cap-rejected-timer (timer armed then reaped).
   */
  readonly "delegate.delivery"?: string;
  /**
   * `true` when a continuation cap (see `disabled.reason`) silenced emission
   * for this step. Carried on the `continuation.disabled` event-span and on
   * the `heartbeat` span when continuation context is present.
   */
  readonly "continuation.disabled"?: boolean;
  /**
   * Gate-axis that produced a `continuation.disabled` reject. Pinned set:
   *   - `"cap.chain"` — `continuationChainCount` reached `maxChainLength`
   *   - `"cap.cost"` — accumulated input+output tokens exceeded `costCapTokens`
   *   - `"cap.delegates_per_turn"` — per-turn delegate-budget cap
   *
   * The enum captures anything that prevented follow-through, not only cap
   * axes. Cap is one shape of gate; transport or policy loss can add future
   * siblings under the same span name.
   */
  readonly "disabled.reason"?: string;
  /**
   * Signal-family classifier. Values are pinned by {@link CONTINUATION_SIGNAL_KINDS} (SSOT).
   * On `continuation.disabled` spans, identifies the rejected signal shape.
   * On `continuation.compaction.released` spans, classifies the release event.
   *
   * @see CONTINUATION_SIGNAL_KINDS — canonical value list
   * @see ContinuationDisabledSignalKind — narrowed subset for disabled spans
   */
  readonly "signal.kind"?: ContinuationSignalKind;
  /**
   * Only set on `continuation.delegate.fire` spans.
   * Wall-clock ms between `setTimeout` arming (immediately before the
   * timer is scheduled at the dispatch site) and the callback actually
   * executing. Diverges from `delay.ms` (the requested delay) under
   * runtime pressure — event-loop blockage, GC pauses, etc.
   *
   * Drift formula: `fire.deferred_ms - delay.ms`. Positive values indicate the
   * timer fired late under load; near-zero is on-schedule. Pinned in JSDoc
   * so every consumer doesn't rediscover the formula.
   *
   * Integer ms (`Math.floor` at emit-time) so the attr round-trips
   * cleanly through OTLP without rounding ambiguity.
   */
  readonly "fire.deferred_ms"?: number;
  /**
   * Only set on `continuation.queue.drain` spans. Total
   * count of system-event entries pulled from the substrate queue at this
   * drain tick (`drainSystemEventEntries(...).length`). Integer ≥ 0.
   *
   * Aggregate, not per-event: one `continuation.queue.drain` span per
   * `drainFormattedSystemEvents` call regardless of how many entries the
   * pull returned. Per-event surfacing belongs on OTEL events attached to
   * this single drain span, not to additional spans.
   */
  readonly "queue.drained_count"?: number;
  /**
   * Only set on `continuation.queue.drain` spans. Subset
   * of `queue.drained_count` whose entry text begins with the
   * continuation-prefix marker (`[continuation:`). Best-effort prefix
   * match at emit-time; structural `traceparent` reconstruction belongs to
   * the concrete tracing adapter, not this shim.
   *
   * Always `≤ queue.drained_count`. Integer ≥ 0.
   */
  readonly "queue.drained_continuation_count"?: number;
  /** Only set on aggregate fan-out return spans. */
  readonly "fanout.mode"?: string;
  /** Only set on aggregate fan-out return spans. */
  readonly "fanout.recipient_count"?: number;
  /** Only set on aggregate fan-out return spans. */
  readonly "fanout.delivered_count"?: number;
  /** Only set on aggregate fan-out return spans. Sha256-12 hashes of recipient session keys; raw keys are not exported to telemetry. */
  readonly "fanout.recipient.session_key_hashes"?: readonly string[];
  /** Only set on aggregate fan-out return spans. */
  readonly "fanout.recipient.outcomes"?: readonly string[];
  /**
   * Only set on `continuation.compaction.released` spans.
   * Aggregate count of staged post-compaction delegates released for
   * dispatch by a single auto-compaction event. Snapshotted from
   * `sessionEntry.pendingPostCompactionDelegates.length` at the moment
   * `dispatchPostCompactionDelegates` is invoked.
   *
   * Integer ≥ 0. May be 0 when auto-compaction occurred but no delegates
   * were staged (the dispatch still runs to consume staged-but-unflushed
   * state); the span is still emitted to mark the compaction event itself.
   */
  readonly "compaction.released"?: number;
  /**
   * Session-local monotone compaction counter. Join key is `(session.id, compaction.id)`.
   *
   * Currently emitted on `continuation.compaction.released` spans. Future
   * post-compaction-mode `continuation.delegate.fire` spans can join via this attr.
   *
   * Invariant: integer ≥ 0, monotone-by-construction at producer (incrementRunCompactionCount).
   */
  readonly "compaction.id"?: number;
  /**
   * Only set on `heartbeat` spans. Opaque per-fire id, unique
   * within a process lifetime so heartbeat-cadence traces can be
   * correlated even when no continuation context is present. Caller-
   * injected from the harness for deterministic test pins; production
   * helper mints one via `crypto.randomUUID()` when omitted.
   */
  readonly "heartbeat.id"?: string;
};

/**
 * Canonical span name set. Pinned at the type so a typo in a call site fails
 * compile, not runtime. Tests mirror this list.
 */
export type ContinuationSpanName =
  | "continuation.work"
  | "continuation.work.fire"
  | "continuation.delegate.dispatch"
  | "continuation.delegate.fire"
  | "continuation.queue.enqueue"
  | "continuation.queue.fanout"
  | "continuation.queue.drain"
  | "continuation.compaction.released"
  | "continuation.disabled"
  | "heartbeat";

/**
 * Status code for a span. Mirrors OTEL's `SpanStatusCode` (UNSET=0, OK=1,
 * ERROR=2) with explicit string names so callers don't depend on the
 * numeric ordinal — keeps the surface OTEL-compatible without being
 * OTEL-bound.
 */
export type SpanStatus = "UNSET" | "OK" | "ERROR";

/**
 * Active span returned by `Tracer.startSpan`. Callers MUST `end()` every
 * span exactly once. The no-op tracer doesn't enforce this, but concrete
 * tracing adapters should.
 *
 * The shape intentionally mirrors `@opentelemetry/api`'s `Span` interface
 * surface (the subset we care about) so concrete adapters can be thin
 * pass-throughs, not re-implementations.
 */
export type Span = {
  /**
   * Add or overwrite attributes on the span. Calling with the same key
   * replaces the previous value (matches OTEL semantics).
   */
  setAttributes(attrs: SpanAttributes): void;
  /**
   * Set the span status. Once set to ERROR, transitioning to OK is
   * permitted (matches OTEL). Implementations SHOULD record the most
   * recent status only.
   */
  setStatus(status: SpanStatus, message?: string): void;
  /**
   * Record an exception against the span. Pure-string variants are
   * accepted for sites that don't carry an Error instance (matches OTEL's
   * `recordException` permissive shape).
   */
  recordException(err: unknown): void;
  /**
   * Return a W3C traceparent for the concrete span when the installed exporter
   * can expose it. Cross-process continuation dispatch uses this after starting
   * the dispatch span so child runs attach to exported trace bytes, not
   * process-local logical ids.
   */
  traceparent?(): string | undefined;
  /**
   * End the span. Idempotent: subsequent calls are no-ops. Matches OTEL.
   */
  end(): void;
};

export type StartSpanOptions = {
  /**
   * Initial attributes attached at span creation. Equivalent to calling
   * `setAttributes` immediately after `startSpan`.
   *
   * The shim accepts `SpanAttributes` (the broader `Record<string,...>`)
   * to permit diagnostic / adapter-internal attributes; canonical-contract
   * keys are pinned by `ContinuationSpanAttrs` and tests.
   */
  attributes?: SpanAttributes;
  /**
   * W3C `traceparent` to anchor the span to an existing trace across deferred
   * or cross-process hops. When omitted, concrete adapters may inherit their
   * process-local active context and otherwise start a new trace. The
   * continuation substrate lifts this onto `SystemEvent.traceparent` so
   * producer-side reconstruction at drain time has the field to read from.
   */
  traceparent?: string;
};

/**
 * Tracer surface used by continuation primitives (`continue_work`,
 * `continue_delegate`, heartbeat) to emit chain-correlated spans.
 *
 * The default `noopTracer` and concrete OTEL adapter conform to this same
 * surface, so continuation call sites do not depend on a specific exporter.
 */
export type Tracer = {
  /**
   * Start a span. Callers MUST `end()` the returned span exactly once.
   *
   * `name` SHOULD be one of the canonical continuation span names so the
   * tests and exporters can rely on the same canonical set:
   *   - `continuation.work`
   *   - `continuation.delegate.dispatch`
   *   - `continuation.queue.enqueue`
   *   - `continuation.queue.drain`
   *   - `continuation.compaction.released`
   *   - `continuation.disabled`
   *   - `heartbeat`
   *
   * The `name` parameter is not type-narrowed to that union because some
   * call sites (diagnostic / debug spans, future adapters) need
   * arbitrary names; tests pin the canonical set.
   */
  startSpan(name: string, options?: StartSpanOptions): Span;
  /**
   * Optional exporter-owned traceparent formatter. Continuation tools call this
   * with OpenClaw's active DiagnosticTraceContext; adapters may translate that
   * logical context to the concrete exported span context for cross-process hops.
   */
  formatTraceparent?: (context: DiagnosticTraceContext) => string | undefined;
};

const noopSpan: Span = Object.freeze({
  setAttributes(_attrs: SpanAttributes): void {
    /* no-op */
  },
  setStatus(_status: SpanStatus, _message?: string): void {
    /* no-op */
  },
  recordException(_err: unknown): void {
    /* no-op */
  },
  traceparent(): string | undefined {
    return undefined;
  },
  end(): void {
    /* no-op */
  },
});

/**
 * Default tracer: every method is a no-op. Returned from
 * `getContinuationTracer()` until an adapter is registered. Callers that don't
 * opt in see no behavior change.
 */
export const noopTracer: Tracer = Object.freeze({
  startSpan(_name: string, _options?: StartSpanOptions): Span {
    return noopSpan;
  },
});

type ContinuationTracerState = {
  activeTracer: Tracer;
};

const CONTINUATION_TRACER_STATE_KEY = Symbol.for("openclaw.continuationTracer.state.v1");

function continuationTracerState(): ContinuationTracerState {
  // Cross-module-identity singleton store, matching the idiom used elsewhere
  // in the codebase (see e.g. outbound-echo-state.ts).
  // SAFETY: globalThis is widened only to read/write this well-known symbol key.
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  // SAFETY: process is widened only to read/write the same well-known symbol key.
  const processStore = process as NodeJS.Process & Record<PropertyKey, unknown>;
  // SAFETY: this process-local key only ever holds a ContinuationTracerState.
  const processState = processStore[CONTINUATION_TRACER_STATE_KEY] as
    | ContinuationTracerState
    | undefined;
  if (processState) {
    globalStore[CONTINUATION_TRACER_STATE_KEY] = processState;
    return processState;
  }
  // SAFETY: same key/producer guarantee as processState above.
  const globalState = globalStore[CONTINUATION_TRACER_STATE_KEY] as
    | ContinuationTracerState
    | undefined;
  if (globalState) {
    processStore[CONTINUATION_TRACER_STATE_KEY] = globalState;
    return globalState;
  }
  const created: ContinuationTracerState = { activeTracer: noopTracer };
  globalStore[CONTINUATION_TRACER_STATE_KEY] = created;
  // Bundled plugin code and core can use different globalThis contexts while
  // sharing one Node process. Bridge through process so every emitter sees the
  // diagnostics adapter instead of silently falling back to the no-op tracer.
  processStore[CONTINUATION_TRACER_STATE_KEY] = created;
  return created;
}

/**
 * Wrap a concrete adapter span so its methods can never throw into the caller's
 * control flow. Continuation dispatch drives `setStatus/recordException/
 * traceparent/end` inside the delegate try/catch/finally; a throwing exporter
 * adapter must not mark a live child failed or escape the loop. Diagnostics are
 * best-effort — on failure we log (when a logger is provided) and no-op.
 */
function guardSpan(span: Span, log?: (message: string) => void): Span {
  const guard = (op: string, run: () => void): void => {
    try {
      run();
    } catch (err) {
      log?.(`continuation.delegate.dispatch span ${op} failed: ${String(err)}`);
    }
  };
  return {
    setAttributes(attrs: SpanAttributes): void {
      guard("setAttributes", () => span.setAttributes(attrs));
    },
    setStatus(status: SpanStatus, message?: string): void {
      guard("setStatus", () => {
        // Preserve call arity: forward the message only when present so the
        // adapter sees the same argument shape as an unwrapped span.
        if (message === undefined) {
          span.setStatus(status);
        } else {
          span.setStatus(status, message);
        }
      });
    },
    recordException(err: unknown): void {
      guard("recordException", () => span.recordException(err));
    },
    traceparent(): string | undefined {
      try {
        return span.traceparent?.();
      } catch (err) {
        log?.(`continuation.delegate.dispatch span traceparent failed: ${String(err)}`);
        return undefined;
      }
    },
    end(): void {
      guard("end", () => span.end());
    },
  };
}

/**
 * Get the active continuation-tracer. Defaults to the no-op tracer until
 * `setContinuationTracer` is called by the diagnostics bootstrap step.
 *
 * The registry is bridged through process and mirrored onto globalThis because
 * continuation code crosses lazy runtime, plugin-SDK, and bundled-plugin module
 * identities that can use different globals within one Node process.
 */
export function getContinuationTracer(): Tracer {
  return continuationTracerState().activeTracer;
}

/**
 * Install a tracer. Used by:
 *   - the OTEL bootstrap (real OTLP wire)
 *   - tests that install an in-memory tracer
 *   - per-test setup that wants to capture span emissions
 *
 * Calling with `noopTracer` (or `null`/`undefined`) resets to the no-op
 * default — primarily for test teardown.
 */
export function setContinuationTracer(tracer: Tracer | null | undefined): void {
  continuationTracerState().activeTracer = tracer ?? noopTracer;
}

/**
 * Reset to the no-op default. Equivalent to `setContinuationTracer(null)`;
 * provided as a clearer test-teardown affordance.
 */
export function resetContinuationTracer(): void {
  continuationTracerState().activeTracer = noopTracer;
}

export function formatContinuationTraceparent(
  context: DiagnosticTraceContext | undefined,
): string | undefined {
  if (!context) {
    return undefined;
  }
  // The exporter-owned formatTraceparent adapter runs in core continuation
  // control flow (dispatch/announce). A throwing adapter must not break the
  // delegate path — fall back to the local formatter (I3).
  let resolved: string | undefined;
  try {
    resolved = getContinuationTracer().formatTraceparent?.(context);
  } catch {
    resolved = undefined;
  }
  return normalizeDiagnosticTraceparent(resolved) ?? formatDiagnosticTraceparent(context);
}

export function formatActiveContinuationTraceparent(): string | undefined {
  const activeContext = getActiveDiagnosticTraceContext();
  if (!activeContext?.parentSpanId) {
    return formatContinuationTraceparent(activeContext);
  }
  return formatContinuationTraceparent({
    traceId: activeContext.traceId,
    spanId: activeContext.parentSpanId,
    traceFlags: activeContext.traceFlags,
    ...(activeContext.parentSpanIdSource === "remote" ? { spanIdSource: "remote" } : {}),
  });
}

export function resolveContinuationTraceparent(
  traceparent: string | undefined,
): string | undefined {
  const normalized = normalizeDiagnosticTraceparent(traceparent);
  const parsed = parseDiagnosticTraceparent(normalized);
  return parsed ? formatContinuationTraceparent(parsed) : undefined;
}

type ContinuationDelegateSpanArgs = {
  chainId: string | undefined;
  chainStepRemaining: number;
  delayMs: number;
  delivery: "immediate" | "timer";
  delegateMode?: string | undefined;
  reason?: string | undefined;
  traceparent?: string | undefined;
  log?: (message: string) => void;
};

const CONTINUATION_REASON_HASH_HEX_LENGTH = 16;

function continuationReasonAttributes(
  reason: string | undefined,
): Pick<
  ContinuationSpanAttrs,
  "reason.present" | "reason.length" | "reason.hash" | "reason.redacted"
> {
  if (!reason) {
    return {};
  }
  const redactedReason = redactToolPayloadText(reason);
  return {
    "reason.present": true,
    "reason.length": reason.length,
    "reason.hash": createHash("sha256")
      .update(redactedReason)
      .digest("hex")
      .slice(0, CONTINUATION_REASON_HASH_HEX_LENGTH),
    "reason.redacted": redactedReason !== reason,
  };
}

function continuationDelegateSpanAttributes(
  args: ContinuationDelegateSpanArgs,
): ContinuationSpanAttrs {
  return {
    "delay.ms": Math.round(args.delayMs),
    "chain.step.remaining": Math.max(0, args.chainStepRemaining),
    "delegate.delivery": args.delivery,
    ...(args.chainId !== undefined && { "chain.id": args.chainId }),
    ...(args.delegateMode !== undefined && { "delegate.mode": args.delegateMode }),
    ...continuationReasonAttributes(args.reason),
  };
}

export function startContinuationDelegateSpan(args: ContinuationDelegateSpanArgs): Span {
  try {
    const span = getContinuationTracer().startSpan("continuation.delegate.dispatch", {
      attributes: continuationDelegateSpanAttributes(args),
      ...(args.traceparent !== undefined ? { traceparent: args.traceparent } : {}),
    });
    // Diagnostics must never break the delegate loop: the concrete adapter span
    // is driven (setStatus/recordException/traceparent/end) inside the dispatch
    // try/catch/finally, so a throwing OTEL adapter would otherwise mark a live
    // child failed or escape the loop. Return a guarded span (I3).
    return guardSpan(span, args.log);
  } catch (err) {
    args.log?.(`Failed to start continuation.delegate.dispatch span: ${String(err)}`);
    return noopSpan;
  }
}

/**
 * Emit a `continuation.work` span at the runner-side accept seam
 * Centralized helper so the runner stays narrow at the call site and the span
 * shape is testable in isolation. Sites that don't have a chainId yet (chain not
 * persisted, or substrate-disabled deploys) MAY pass `chainId:
 * undefined` — the attribute is omitted, downstream collectors
 * see a span without a correlation key.
 *
 * Wraps tracer interactions in a try/catch and logs via the caller's
 * `log` callback if provided — the accept path must never block on
 * span emission.
 */
export function emitContinuationWorkSpan(args: {
  chainId: string | undefined;
  chainStepRemaining: number;
  delayMs: number;
  reason?: string | undefined;
  traceparent?: string | undefined;
  log?: (message: string) => void;
}): void {
  try {
    const attrs: ContinuationSpanAttrs = {
      "delay.ms": Math.round(args.delayMs),
      "chain.step.remaining": Math.max(0, args.chainStepRemaining),
      ...(args.chainId !== undefined && { "chain.id": args.chainId }),
      ...continuationReasonAttributes(args.reason),
    };
    const span = getContinuationTracer().startSpan("continuation.work", {
      attributes: attrs,
      ...(args.traceparent !== undefined ? { traceparent: args.traceparent } : {}),
    });
    span.setStatus("OK");
    span.end();
  } catch (err) {
    args.log?.(`Failed to emit continuation.work span: ${String(err)}`);
  }
}

/**
 * Emit a `continuation.delegate.dispatch` span at the runner-side
 * delegate accept seam. Mirrors
 * `emitContinuationWorkSpan` shape — same try/catch wrap, same
 * `chain.id` / `chain.step.remaining` / `delay.ms` / privacy-safe
 * reason metadata plumbing — plus two delegate-specific axes:
 *
 *  - `delegate.delivery` (`"immediate" | "timer"`): runner-internal
 *    scheduling axis. `"immediate"` when no delay was requested or
 *    the delay was 0 (no `setTimeout` armed); `"timer"` when a
 *    non-zero clamped delay armed `setTimeout`.
 *  - `delegate.mode` (`"normal" | "silent" | "silent-wake" |
 *    "post-compaction"`): caller-intent semantic axis. Optional in
 *    the helper signature so future call sites (e.g. an exporter
 *    replaying a partial dispatch record) can emit without a mode
 *    annotation; current runner wiring always supplies one.
 *
 * Emit at the enqueue/accept seam, not at the timer-fire callback. The chain-step
 * is committed when the runner accepts the dispatch into the chain;
 * the `setTimeout` is a delivery mechanism, not a chain semantic.
 * Cancelled-but-accepted dispatches (compaction, reset, gateway shutdown)
 * still happened, and a fire-time span would underreport them.
 * `continuation.delegate.fire` records the later timer-callback event.
 *
 * Wraps tracer interactions in a try/catch and logs via the caller's
 * `log` callback if provided — the accept path must never block on
 * span emission.
 */
export function emitContinuationDelegateSpan(args: {
  chainId: string | undefined;
  chainStepRemaining: number;
  delayMs: number;
  delivery: "immediate" | "timer";
  delegateMode?: string | undefined;
  reason?: string | undefined;
  traceparent?: string | undefined;
  log?: (message: string) => void;
}): void {
  try {
    const span = startContinuationDelegateSpan(args);
    span.setStatus("OK");
    span.end();
  } catch (err) {
    args.log?.(`Failed to emit continuation.delegate.dispatch span: ${String(err)}`);
  }
}

/**
 * Emit a `continuation.disabled` span at a runner-side cap-gate reject
 * Mirrors `emitContinuationWorkSpan` /
 * `emitContinuationDelegateSpan` shape — same try/catch wrap, same
 * `chain.id` / `chain.step.remaining` / privacy-safe reason metadata plumbing. Adds
 * three reject-specific axes:
 *
 *  - `disabled.reason` (`"cap.chain" | "cap.cost" |
 *    "cap.delegates_per_turn" |
 *    "policy.cross_session_targeting"`): which gate
 *    prevented follow-through. The family covers cap axes and non-cap gates.
 *  - `signal.kind` ({@link ContinuationDisabledSignalKind}): the kind of
 *    signal that was rejected. Values derived from {@link CONTINUATION_SIGNAL_KINDS} SSOT.
 *  - `delegate.delivery` / `delegate.mode`: only set when the rejected
 *    signal was a delegate (bracket-delegate or tool-delegate). Work
 *    signals omit both — they're self-elected single-session and don't
 *    share that taxonomy.
 *
 * A reject means the chain never advanced for this signal. Helper does NOT mint or persist a
 * `chain.id` for reject spans — callers pass `chainId` through as-is
 * from the live session entry (which may be `undefined` when the
 * rejected signal would have been the first chain step). `chain.step.remaining`
 * is set to the chain-budget remaining at the moment of reject, NOT
 * post-decrement (no decrement happens on rejects).
 *
 * Wraps tracer interactions in a try/catch and logs via the caller's
 * `log` callback if provided — the reject path must never block on
 * span emission.
 */
export function emitContinuationDisabledSpan(args: {
  chainId: string | undefined;
  chainStepRemaining: number;
  disabledReason:
    | "cap.chain"
    | "cap.cost"
    | "cap.delegates_per_turn"
    | "policy.cross_session_targeting";
  signalKind: ContinuationDisabledSignalKind;
  delegateDelivery?: "immediate" | "timer" | undefined;
  delegateMode?: string | undefined;
  reason?: string | undefined;
  log?: (message: string) => void;
}): void {
  try {
    const attrs: ContinuationSpanAttrs = {
      "chain.step.remaining": Math.max(0, args.chainStepRemaining),
      "disabled.reason": args.disabledReason,
      "signal.kind": args.signalKind,
      "continuation.disabled": true,
      ...(args.chainId !== undefined && { "chain.id": args.chainId }),
      ...(args.delegateDelivery !== undefined && {
        "delegate.delivery": args.delegateDelivery,
      }),
      ...(args.delegateMode !== undefined && { "delegate.mode": args.delegateMode }),
      ...continuationReasonAttributes(args.reason),
    };
    const span = getContinuationTracer().startSpan("continuation.disabled", {
      attributes: attrs,
    });
    span.setStatus("OK");
    span.end();
  } catch (err) {
    args.log?.(`Failed to emit continuation.disabled span: ${String(err)}`);
  }
}

/**
 * Emit a `continuation.delegate.fire` span at the runner-side delegate
 * timer-callback start. The verb-on-timer
 * counterpart to `emitContinuationDelegateSpan`'s verb-on-decision: this
 * span fires at the moment a deferred delegate's `setTimeout` callback
 * actually runs, so consumers can pair `dispatch`/`fire` events on the
 * same `chain.id` and observe scheduling drift / fire-time divergences.
 *
 * Callsite invariants:
 *
 *  - Emit at the common TaskFlow dispatch fire seam — the fire event is
 *    wall-clock truth ("the delayed delegate matured"); whatever happens next
 *    (spawn accepted/rejected/failed) is recorded by the dispatch span and
 *    system-event breadcrumbs.
 *  - `chainId` is supplied by the common dispatch path before spawn. The helper
 *    never re-reads session state at fire-time, which prevents races with
 *    compaction or session mutation between arm and fire.
 *  - `chainId` is **always defined** at delegate-fire time — chain
 *    dispatch mints before spawn. The signature encodes
 *    this with the non-optional `string` type. **Defense-in-depth:**
 *    helper no-ops gracefully (logs + returns) if `undefined` slips
 *    through anyway, so a future invariant break never crashes
 *    fire-emit.
 *  - `delegate.delivery: "timer"` is implicit — fire spans only emit on
 *    the timer-deferred path (immediate-delivery dispatches don't
 *    arm a timer, so there's no fire event for them). The helper sets
 *    the attr internally rather than taking it as an arg.
 *  - This is instrumentation-only: the helper does NOT
 *    re-evaluate any cap (`cap.chain | cap.cost | cap.delegates_per_turn`)
 *    at fire-time. Fire-time gating is a future-policy seam.
 *
 * `chainStepRemainingAtDispatch` reflects dispatch-time headroom, not callback-time
 * live state. Rationale: trace continuity with the dispatch span (same
 * `chain.id`, same step counter) so consumers can pair `dispatch` /
 * `fire` events without reasoning about between-tick mutations. If a
 * future consumer wants "remaining headroom _at_ fire time," that is a
 * **separate axis** (provisional name `chain.step.remaining_at_fire`)
 * and a **separate decision** — do not fold it into this field.
 *
 * Wraps tracer interactions in a try/catch and logs via the caller's
 * `log` callback if provided — the fire path must never block on span
 * emission.
 */
export function emitContinuationDelegateFireSpan(args: {
  chainId: string;
  chainStepRemainingAtDispatch: number;
  delegateMode: "normal" | "silent" | "silent-wake";
  delayMs: number;
  fireDeferredMs: number;
  reason?: string | undefined;
  traceparent?: string | undefined;
  log?: (message: string) => void;
}): void {
  // Defense-in-depth: invariant says chainId is always defined at
  // delegate-fire time because dispatch mints before setTimeout. The signature encodes the
  // invariant via non-optional `string`, but a future change that lets
  // `undefined` slip through must NOT crash fire-emit. No-op + log so
  // the divergence is visible without taking down the timer callback.
  if (args.chainId === undefined || args.chainId === null) {
    args.log?.(
      "Failed to emit continuation.delegate.fire span: chainId invariant violated (undefined)",
    );
    return;
  }
  try {
    const attrs: ContinuationSpanAttrs = {
      "chain.id": args.chainId,
      "chain.step.remaining": Math.max(0, args.chainStepRemainingAtDispatch),
      "delay.ms": Math.round(args.delayMs),
      "fire.deferred_ms": Math.max(0, Math.floor(args.fireDeferredMs)),
      "delegate.delivery": "timer",
      "delegate.mode": args.delegateMode,
      ...continuationReasonAttributes(args.reason),
    };
    const span = getContinuationTracer().startSpan("continuation.delegate.fire", {
      attributes: attrs,
      ...(args.traceparent !== undefined ? { traceparent: args.traceparent } : {}),
    });
    span.setStatus("OK");
    span.end();
  } catch (err) {
    args.log?.(`Failed to emit continuation.delegate.fire span: ${String(err)}`);
  }
}

/**
 * Emit a `continuation.work.fire` span at the bracket-work timer-callback
 * seam. Symmetric to `emitContinuationDelegateFireSpan`
 * but scope-narrower: WORK-fire has NO fire-time divergence in current bytes
 * (`enqueueSystemEvent` and `requestHeartbeatNow` are synchronous and
 * non-divergent), so 5c emits a single span with no `continuation.disabled`
 * sibling.
 *
 * `continuation.work.fire` uses a separate helper because work-fire has no
 * delegate dispatch outcome. Privacy-safe reason metadata is captured from
 * dispatch-time closure state so operator triage can pair
 * `continuation.work` and `continuation.work.fire` spans without exporting
 * raw reason text.
 *
 * Provenance pins:
 *  - `chainId` is closed-over from dispatch-time `persistContinuationChainState`
 *    return value. Never recomputed at fire-time.
 *  - `chainStepRemainingAtDispatch` is a dispatch-time snapshot, NOT a
 *    fire-time recompute. Trace continuity with the dispatch span (same
 *    `chain.id`, same step counter) so consumers can pair `work` / `work.fire`
 *    events without reasoning about between-tick mutations.
 *  - This is instrumentation-only: helper does NOT re-evaluate
 *    any cap (`cap.chain | cap.cost | cap.delegates_per_turn`) at fire-time.
 *    Fire-time gating is a future-policy seam.
 *  - `fire.deferred_ms` = wall-clock from `setTimeout`-arm to callback fire,
 *    `Math.floor` integer ms. Drift formula: `fire.deferred_ms - delay.ms`.
 *
 * Wraps tracer interactions in a try/catch and logs via the caller's `log`
 * callback if provided — the fire path must never block on span emission.
 */
export function emitContinuationWorkFireSpan(args: {
  chainId: string;
  chainStepRemainingAtDispatch: number;
  delayMs: number;
  fireDeferredMs: number;
  reason?: string | undefined;
  traceparent?: string | undefined;
  log?: (message: string) => void;
}): void {
  // Defense-in-depth: invariant says chainId is always defined at
  // work-fire time because persistContinuationChainState mints before setTimeout.
  // Sig encodes the invariant via non-optional `string`, but a future change
  // that lets `undefined` slip through must NOT crash fire-emit. No-op + log
  // so the divergence is visible without taking down the timer callback.
  if (args.chainId === undefined || args.chainId === null) {
    args.log?.(
      "Failed to emit continuation.work.fire span: chainId invariant violated (undefined)",
    );
    return;
  }
  try {
    const attrs: ContinuationSpanAttrs = {
      "chain.id": args.chainId,
      "chain.step.remaining": Math.max(0, args.chainStepRemainingAtDispatch),
      "delay.ms": Math.round(args.delayMs),
      "fire.deferred_ms": Math.max(0, Math.floor(args.fireDeferredMs)),
      ...continuationReasonAttributes(args.reason),
    };
    const span = getContinuationTracer().startSpan("continuation.work.fire", {
      attributes: attrs,
      ...(args.traceparent !== undefined ? { traceparent: args.traceparent } : {}),
    });
    span.setStatus("OK");
    span.end();
  } catch (err) {
    args.log?.(`Failed to emit continuation.work.fire span: ${String(err)}`);
  }
}

/**
 * Emit a `continuation.queue.drain` span at the substrate system-events
 * queue consumer seam. Fired once per
 * `drainFormattedSystemEvents` call, regardless of how many entries the
 * synchronous bulk-pull returned (including empty drains).
 *
 * `continuation.queue.drain` is the consumer-side pair to
 * `continuation.queue.enqueue`. It records aggregate counts only; no
 * `chain.id` is attached because the substrate queue is session-scoped and may
 * be multi-chain at drain time. A zero-count drain is absence of work, not a
 * `continuation.disabled` gate.
 *
 * Wraps tracer interactions in a try/catch and forwards exceptions to the
 * caller's `log` callback if provided \u2014 the drain path must never block
 * on span emission, and must not perturb drain semantics (the span fires
 * AFTER the drain completes; emit failure is invisible to the consumer).
 */
export function emitContinuationQueueDrainSpan(args: {
  drainedCount: number;
  drainedContinuationCount: number;
  traceparent?: string | undefined;
  log?: (message: string) => void;
}): void {
  try {
    const drainedCount = Math.max(0, Math.floor(args.drainedCount));
    // Defense-in-depth: cap continuation subset by total drained count.
    // The wire site at session-system-events.ts already guarantees this
    // (continuation count is a filter over the same array we measured),
    // but a less-disciplined caller could violate the `≤` invariant.
    const drainedContinuationCount = Math.min(
      drainedCount,
      Math.max(0, Math.floor(args.drainedContinuationCount)),
    );
    const attrs: ContinuationSpanAttrs = {
      "queue.drained_count": drainedCount,
      "queue.drained_continuation_count": drainedContinuationCount,
    };
    const span = getContinuationTracer().startSpan("continuation.queue.drain", {
      attributes: attrs,
      ...(args.traceparent !== undefined ? { traceparent: args.traceparent } : {}),
    });
    span.setStatus("OK");
    span.end();
  } catch (err) {
    args.log?.(`Failed to emit continuation.queue.drain span: ${String(err)}`);
  }
}

export function emitContinuationFanoutSpan(args: {
  fanoutMode?: string | undefined;
  targetSessionKeys: readonly string[];
  deliveredCount: number;
  chainStepRemaining?: number | undefined;
  traceparent?: string | undefined;
  log?: (message: string) => void;
}): void {
  try {
    const recipientCount = Math.max(0, Math.floor(args.targetSessionKeys.length));
    const deliveredCount = Math.min(recipientCount, Math.max(0, Math.floor(args.deliveredCount)));
    // Session keys can include channel/account/conversation identifiers, and
    // diagnostics-otel may export spans outside the local process. Hash before
    // emitting so downstream collectors get a stable correlation handle without
    // raw routing data leaking into telemetry.
    const recipientHashes = args.targetSessionKeys.map((key) =>
      createHash("sha256").update(key).digest("hex").slice(0, 12),
    );
    const attrs: ContinuationSpanAttrs = {
      "fanout.recipient_count": recipientCount,
      "fanout.delivered_count": deliveredCount,
      "fanout.recipient.session_key_hashes": recipientHashes,
      "fanout.recipient.outcomes": args.targetSessionKeys.map((_, index) =>
        index < deliveredCount ? "delivered" : "queued",
      ),
      ...(args.fanoutMode !== undefined ? { "fanout.mode": args.fanoutMode } : {}),
      ...(args.chainStepRemaining !== undefined
        ? { "chain.step.remaining": Math.max(0, args.chainStepRemaining) }
        : {}),
    };
    const span = getContinuationTracer().startSpan("continuation.queue.fanout", {
      attributes: attrs,
      ...(args.traceparent !== undefined ? { traceparent: args.traceparent } : {}),
    });
    span.setStatus("OK");
    span.end();
  } catch (err) {
    args.log?.(`Failed to emit continuation.queue.fanout span: ${String(err)}`);
  }
}

/**
 * Emit a `continuation.compaction.released` span at the agent-runner
 * post-compaction-delegate dispatch seam. Fired
 * once per `autoCompactionCount > 0` branch, after
 * `dispatchPostCompactionDelegates` returns, with the released-count
 * snapshotted before the dispatch call.
 *
 * Mirrors `emitContinuationQueueDrainSpan` shape. Integer hygiene
 * (`Math.max(0, Math.floor(...))`) keeps the invariant local even though
 * the caller snapshots from a `.length` (structurally non-negative).
 *
 * Wraps tracer interactions in a try/catch and forwards exceptions to the
 * caller's `log` callback if provided — the release path must never block
 * on span emission.
 */
export function emitContinuationCompactionReleasedSpan(args: {
  releasedCount: number;
  compactionId?: number;
  traceparent?: string | undefined;
  log?: (message: string) => void;
}): void {
  try {
    const releasedCount = Math.max(0, Math.floor(args.releasedCount));

    // §B validate-and-drop-with-log: attach compaction.id only when the
    // producer-side invariant (integer ≥ 0) holds. No clamp, no throw —
    // the invariant is producer-side; helper is defensive only in the sense
    // of **not emitting a lie**. Logging fires before construction so the
    // validation path is visible even if construction itself ever throws.
    const compactionId = args.compactionId;
    const compactionIdValid =
      typeof compactionId === "number" && Number.isInteger(compactionId) && compactionId >= 0;
    if (!compactionIdValid && compactionId !== undefined) {
      args.log?.(
        `emitContinuationCompactionReleasedSpan: invalid compaction.id (${compactionId}); dropping attr`,
      );
    }

    // Construction-time conditional spread keeps the readonly invariant of
    // ContinuationSpanAttrs intact — no post-construction mutation, no cast.
    const attrs: ContinuationSpanAttrs = {
      "signal.kind": "compaction-release",
      "compaction.released": releasedCount,
      ...(compactionIdValid ? { "compaction.id": compactionId } : {}),
    };

    const span = getContinuationTracer().startSpan("continuation.compaction.released", {
      attributes: attrs,
      ...(args.traceparent !== undefined ? { traceparent: args.traceparent } : {}),
    });
    span.setStatus("OK");
    span.end();
  } catch (err) {
    args.log?.(`Failed to emit continuation.compaction.released span: ${String(err)}`);
  }
}
