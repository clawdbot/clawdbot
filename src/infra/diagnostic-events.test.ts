// Covers diagnostic event emission and metadata handling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasInternalDiagnosticEventListeners } from "./diagnostic-event-listener-presence.js";
import {
  areDiagnosticsEnabledForProcess,
  emitDiagnosticEvent,
  emitInternalDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  emitTrustedSkillUsedDiagnosticEvent,
  emitTrustedSecurityEvent,
  formatDiagnosticTraceparentForPropagation,
  hasPendingInternalDiagnosticEvent,
  isInternalDiagnosticEventMetadata,
  isDiagnosticsEnabled,
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventMetadata,
  type DiagnosticEventPrivateData,
  type DiagnosticEventPayload,
} from "./diagnostic-events.js";
import { isCoreSemanticRunProgressDiagnosticMetadata } from "./diagnostic-semantic-run-progress.js";
import {
  createDiagnosticTraceContext,
  formatDiagnosticTraceparent,
  runWithDiagnosticTraceContext,
} from "./diagnostic-trace-context.js";
import {
  type DiagnosticTracePropagationBridge,
  formatPropagatedDiagnosticTraceparent,
  registerDiagnosticTracePropagationBridge,
} from "./diagnostic-trace-propagation.js";

describe("diagnostic-events", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    vi.restoreAllMocks();
  });

  function expectConsoleErrorPrefix(errorSpy: { mock: { calls: unknown[][] } }, prefix: string) {
    expect(errorSpy.mock.calls).toHaveLength(1);
    const [call] = errorSpy.mock.calls;
    if (!call) {
      throw new Error("expected console error call");
    }
    const [message] = call;
    expect(typeof message).toBe("string");
    expect((message as string).startsWith(prefix)).toBe(true);
  }

  it("reports active internal diagnostic listeners only while dispatch is enabled", () => {
    const hasActiveListeners = () =>
      areDiagnosticsEnabledForProcess() && hasInternalDiagnosticEventListeners();
    expect(hasActiveListeners()).toBe(false);

    const stopInternal = onInternalDiagnosticEvent(() => undefined);
    expect(hasActiveListeners()).toBe(true);
    setDiagnosticsEnabledForProcess(false);
    expect(hasActiveListeners()).toBe(false);
    setDiagnosticsEnabledForProcess(true);
    stopInternal();
    expect(hasActiveListeners()).toBe(false);

    const stopTrusted = onTrustedInternalDiagnosticEvent(() => undefined);
    expect(hasActiveListeners()).toBe(true);
    stopTrusted();
    expect(hasActiveListeners()).toBe(false);
  });

  it("emits monotonic seq and timestamps to subscribers", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(111).mockReturnValueOnce(222);
    const events: Array<{ seq: number; ts: number; type: string }> = [];
    const stop = onDiagnosticEvent((event) => {
      events.push({ seq: event.seq, ts: event.ts, type: event.type });
    });

    emitDiagnosticEvent({
      type: "model.usage",
      usage: { total: 1 },
    });
    emitDiagnosticEvent({
      type: "session.state",
      state: "processing",
    });
    stop();

    expect(events).toEqual([
      { seq: 1, ts: 111, type: "model.usage" },
      { seq: 2, ts: 222, type: "session.state" },
    ]);
  });

  it("isolates listener failures and logs them", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    onDiagnosticEvent(() => {
      throw new Error("boom");
    });
    onDiagnosticEvent((event) => {
      seen.push(event.type);
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "telegram",
    });

    expect(seen).toEqual(["message.queued"]);
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener error type=message.queued seq=1: Error: boom",
    );
  });

  it("supports unsubscribe and full reset", () => {
    const seen: string[] = [];
    const stop = onDiagnosticEvent((event) => {
      seen.push(event.type);
    });

    emitDiagnosticEvent({
      type: "webhook.received",
      channel: "telegram",
    });
    stop();
    emitDiagnosticEvent({
      type: "webhook.processed",
      channel: "telegram",
    });

    expect(seen).toEqual(["webhook.received"]);

    resetDiagnosticEventsForTest();
    emitDiagnosticEvent({
      type: "webhook.error",
      channel: "telegram",
      error: "failed",
    });
    expect(seen).toEqual(["webhook.received"]);
  });

  it("carries explicit trace context without creating retained trace state", () => {
    const trace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    });
    const events: Array<{ trace: typeof trace | undefined; type: string }> = [];
    const stop = onDiagnosticEvent((event) => {
      events.push({ trace: event.trace, type: event.type });
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "telegram",
      trace,
    });
    stop();
    emitDiagnosticEvent({
      type: "message.queued",
      source: "telegram",
      trace,
    });

    expect(events).toEqual([{ trace, type: "message.queued" }]);
  });

  it("uses active request trace context when events omit explicit trace", () => {
    const trace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    });
    const explicitTrace = createDiagnosticTraceContext({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
    });
    const events: Array<{ trace: typeof trace | undefined; type: string }> = [];
    const stop = onDiagnosticEvent((event) => {
      events.push({ trace: event.trace, type: event.type });
    });

    runWithDiagnosticTraceContext(trace, () => {
      emitDiagnosticEvent({
        type: "message.queued",
        source: "telegram",
      });
      emitDiagnosticEvent({
        type: "message.queued",
        source: "telegram",
        trace: explicitTrace,
      });
    });
    stop();

    expect(events).toEqual([
      { trace, type: "message.queued" },
      { trace: explicitTrace, type: "message.queued" },
    ]);
  });

  it("marks dispatcher provenance separately from trust", async () => {
    const events: Array<{
      internal: boolean;
      metadataTrusted: boolean;
      type: string;
    }> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      events.push({
        internal: isInternalDiagnosticEventMetadata(metadata),
        metadataTrusted: metadata.trusted,
        type: event.type,
      });
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "plugin",
    });
    emitInternalDiagnosticEvent({
      type: "webhook.received",
      channel: "telegram",
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(events).toEqual([
      { internal: false, metadataTrusted: false, type: "message.queued" },
      { internal: true, metadataTrusted: false, type: "webhook.received" },
      { internal: false, metadataTrusted: true, type: "model.call.started" },
    ]);
    expect(isInternalDiagnosticEventMetadata({ trusted: false })).toBe(false);
  });

  it("formats traceparent for propagation only from dispatcher-trusted metadata", () => {
    const trace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    });
    const traceparents: Array<string | undefined> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      traceparents.push(formatDiagnosticTraceparentForPropagation(event, metadata));
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "plugin",
      trace,
    });
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      usage: { total: 1 },
      trace,
    });

    expect(traceparents).toEqual([undefined, `00-${trace.traceId}-${trace.spanId}-01`]);
    expect(formatDiagnosticTraceparentForPropagation({ trace }, { trusted: true })).toBeUndefined();
    expect(
      formatDiagnosticTraceparentForPropagation(
        { trace },
        { trusted: false, trustedTraceContext: true },
      ),
    ).toBeUndefined();
  });

  it("prepares trusted events synchronously without cloning private data", async () => {
    const diagnosticTrace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    });
    const exportedTrace = createDiagnosticTraceContext({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      traceFlags: "00",
    });
    const prepared: string[] = [];
    let privateDataReads = 0;
    const bridge: DiagnosticTracePropagationBridge<
      DiagnosticEventPayload,
      DiagnosticEventMetadata
    > = {
      shouldPrepareEvent(event) {
        return event.type === "model.call.started";
      },
      prepareEvent(event) {
        prepared.push(event.type);
      },
      resolveTraceContext(traceContext) {
        expect(traceContext).toBe(diagnosticTrace);
        return exportedTrace;
      },
    };
    registerDiagnosticTracePropagationBridge(bridge);

    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.call.started",
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: diagnosticTrace,
      },
      {
        modelContent: {
          get inputMessages() {
            privateDataReads += 1;
            return ["secret prompt"];
          },
        },
      },
    );
    expect(privateDataReads).toBe(0);
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 1,
      trace: diagnosticTrace,
    });

    expect(prepared).toEqual(["model.call.started"]);
    expect(formatDiagnosticTraceparent(diagnosticTrace)).toBe(
      `00-${diagnosticTrace.traceId}-${diagnosticTrace.spanId}-01`,
    );
    expect(formatPropagatedDiagnosticTraceparent(diagnosticTrace)).toBe(
      `00-${exportedTrace.traceId}-${exportedTrace.spanId}-00`,
    );
    await waitForDiagnosticEventsDrained();
    expect(privateDataReads).toBe(0);
  });

  it("does not fall back to diagnostic ids when an active propagation bridge misses", () => {
    const diagnosticTrace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    });
    registerDiagnosticTracePropagationBridge({
      resolveTraceContext: () => undefined,
    });

    expect(formatDiagnosticTraceparent(diagnosticTrace)).toBe(
      `00-${diagnosticTrace.traceId}-${diagnosticTrace.spanId}-01`,
    );
    expect(formatPropagatedDiagnosticTraceparent(diagnosticTrace)).toBeUndefined();
  });

  it("shares semantic provenance across duplicate module instances", async () => {
    const events: Array<{ coreSemantic: boolean; type: string }> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      events.push({
        coreSemantic: isCoreSemanticRunProgressDiagnosticMetadata(metadata),
        type: event.type,
      });
    });

    vi.resetModules();
    const duplicateSemanticProgress = await import(
      /* @vite-ignore */ new URL("./diagnostic-semantic-run-progress.ts?duplicate", import.meta.url)
        .href
    );
    duplicateSemanticProgress.emitCoreSemanticRunProgressDiagnosticEvent({
      runId: "duplicate-semantic-run",
      reason: "model_call:semantic_result",
    });
    await waitForDiagnosticEventsDrained();

    expect(events).toEqual([{ coreSemantic: true, type: "run.progress" }]);
  });

  it("does not expose mutable diagnostic state on the obsolete global symbol", async () => {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    const events: boolean[] = [];
    globalStore[Symbol.for("openclaw.diagnosticEventsState")] = {
      listeners: new Set([() => events.push(true)]),
    };
    onInternalDiagnosticEvent((eventValue, metadata) => {
      events.push(metadata.trusted);
    });

    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(events).toEqual([false]);
    delete globalStore[Symbol.for("openclaw.diagnosticEventsState")];
  });

  it("keeps trusted internal events off the public diagnostic stream", async () => {
    const publicEvents: string[] = [];
    const internalEvents: Array<{ trusted: boolean; type: string }> = [];
    onDiagnosticEvent((event) => {
      publicEvents.push(event.type);
    });
    onInternalDiagnosticEvent((event, metadata) => {
      internalEvents.push({ trusted: metadata.trusted, type: event.type });
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(publicEvents).toStrictEqual([]);
    expect(internalEvents).toEqual([{ trusted: true, type: "model.call.started" }]);
  });

  it.each([true, false])(
    "keeps skill file identity trusted-only when diagnostics enabled=%s",
    async (enabled) => {
      const skillFile = "/workspace/skills/daily-brief/SKILL.md";
      const publicEvents: DiagnosticEventPayload[] = [];
      const sharedEvents: DiagnosticEventPayload[] = [];
      const trustedEvents: Array<{
        event: DiagnosticEventPayload;
        privateData: DiagnosticEventPrivateData;
      }> = [];
      onDiagnosticEvent((event) => publicEvents.push(event));
      onInternalDiagnosticEvent((event) => sharedEvents.push(event));
      onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
        trustedEvents.push({ event, privateData });
      });
      setDiagnosticsEnabledForProcess(enabled);

      emitTrustedSkillUsedDiagnosticEvent(
        {
          type: "skill.used",
          skillName: "Daily Brief",
          skillSource: "workspace",
          activation: "read",
        },
        { skillUsage: { skillFile } },
      );
      await waitForDiagnosticEventsDrained();

      expect(JSON.stringify(publicEvents)).not.toContain(skillFile);
      expect(JSON.stringify(sharedEvents)).not.toContain(skillFile);
      expect(JSON.stringify(trustedEvents[0]?.event)).not.toContain(skillFile);
      expect(trustedEvents).toHaveLength(1);
      expect(trustedEvents[0]?.event).not.toHaveProperty("skillFile");
      expect(trustedEvents[0]?.privateData.skillUsage?.skillFile).toBe(skillFile);
    },
  );

  it("emits canonical security events only through the trusted security helper", () => {
    const internalEvents: Array<{
      action?: string;
      eventId?: string;
      trusted: boolean;
      type: string;
    }> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      internalEvents.push({
        action: event.type === "security.event" ? event.action : undefined,
        eventId: event.type === "security.event" ? event.eventId : undefined,
        trusted: metadata.trusted,
        type: event.type,
      });
    });

    emitDiagnosticEvent({
      type: "security.event",
      eventId: "untrusted-security-event",
      category: "tool",
      action: "tool.execution.blocked",
      outcome: "denied",
      severity: "medium",
    } as unknown as Parameters<typeof emitDiagnosticEvent>[0]);
    emitTrustedDiagnosticEvent({
      type: "security.event",
      eventId: "generic-trusted-security-event",
      category: "tool",
      action: "tool.execution.blocked",
      outcome: "denied",
      severity: "medium",
    } as unknown as Parameters<typeof emitTrustedDiagnosticEvent>[0]);
    emitTrustedSecurityEvent({
      eventId: "security-event-1",
      category: "tool",
      action: "tool.execution.blocked",
      outcome: "denied",
      severity: "medium",
    });

    expect(internalEvents).toEqual([
      {
        action: "tool.execution.blocked",
        eventId: "security-event-1",
        trusted: true,
        type: "security.event",
      },
    ]);
  });

  it("keeps trusted security events off the public diagnostic stream", () => {
    const publicEvents: string[] = [];
    const internalEvents: Array<{ trusted: boolean; type: string }> = [];
    onDiagnosticEvent((event) => {
      publicEvents.push(event.type);
    });
    onInternalDiagnosticEvent((event, metadata) => {
      internalEvents.push({ trusted: metadata.trusted, type: event.type });
    });

    emitTrustedSecurityEvent({
      eventId: "security-event-public-filter",
      category: "auth",
      action: "gateway.auth.failed",
      outcome: "failure",
      severity: "medium",
    });

    expect(publicEvents).toStrictEqual([]);
    expect(internalEvents).toEqual([{ trusted: true, type: "security.event" }]);
  });

  it("isolates diagnostic metadata from listener mutation", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: boolean[] = [];
    onInternalDiagnosticEvent((eventValue, metadata) => {
      (metadata as { trusted: boolean }).trusted = true;
    });
    onInternalDiagnosticEvent((eventValue, metadata) => {
      seen.push(metadata.trusted);
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "plugin",
    });

    expect(seen).toEqual([false]);
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener error type=message.queued seq=1: TypeError",
    );
  });

  it("isolates trusted event trace context from listener mutation", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const trace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    });
    const seen: Array<{ traceId: string | undefined; trusted: boolean }> = [];
    onInternalDiagnosticEvent((event) => {
      (event.trace as { traceId: string }).traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    });
    onInternalDiagnosticEvent((event, metadata) => {
      seen.push({ traceId: event.trace?.traceId, trusted: metadata.trusted });
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      trace,
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(seen).toEqual([{ traceId: trace.traceId, trusted: true }]);
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener error type=model.call.started seq=1: TypeError",
    );
  });

  it("isolates nested diagnostic payloads from listener mutation", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: Array<{ total: number | undefined; trusted: boolean }> = [];
    onInternalDiagnosticEvent((event) => {
      if (event.type === "model.usage") {
        event.usage.total = 0;
      }
    });
    onInternalDiagnosticEvent((event, metadata) => {
      if (event.type === "model.usage") {
        seen.push({ total: event.usage.total, trusted: metadata.trusted });
      }
    });

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      usage: { total: 42 },
    });

    expect(seen).toEqual([{ total: 42, trusted: true }]);
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener error type=model.usage seq=1: TypeError",
    );
  });

  it("drops prototype-pollution keys during event enrichment", () => {
    const eventInput = Object.assign(Object.create(null), {
      type: "message.queued",
      source: "plugin",
      constructor: "blocked",
      prototype: "blocked",
    }) as Parameters<typeof emitDiagnosticEvent>[0] & Record<string, unknown>;
    Object.defineProperty(eventInput, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    const events: Array<Parameters<Parameters<typeof onInternalDiagnosticEvent>[0]>[0]> = [];
    onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    emitDiagnosticEvent(eventInput);

    expect(events).toHaveLength(1);
    expect(Object.hasOwn(events[0] ?? {}, "__proto__")).toBe(false);
    expect(Object.hasOwn(events[0] ?? {}, "constructor")).toBe(false);
    expect(Object.hasOwn(events[0] ?? {}, "prototype")).toBe(false);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("dispatches high-frequency tool and model lifecycle events asynchronously", async () => {
    const events: string[] = [];
    onDiagnosticEvent((event) => {
      events.push(event.type);
    });

    emitDiagnosticEvent({
      type: "tool.execution.started",
      toolName: "read",
    });
    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
    });

    expect(events).toStrictEqual([]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(events).toEqual(["tool.execution.started", "model.call.started"]);
  });

  it("yields between large high-frequency diagnostic event bursts", async () => {
    const events: string[] = [];
    onDiagnosticEvent((event) => {
      events.push(event.type);
    });

    for (let index = 0; index < 250; index += 1) {
      emitDiagnosticEvent({
        type: "model.call.started",
        runId: `run-${index}`,
        callId: `call-${index}`,
        provider: "openai",
        model: "gpt-5.4",
      });
    }

    expect(events).toStrictEqual([]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(events).toHaveLength(100);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(events).toHaveLength(200);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(events).toHaveLength(250);
  });

  it("waits for all queued high-frequency diagnostic events to drain", async () => {
    const events: string[] = [];
    onDiagnosticEvent((event) => {
      events.push(event.type);
    });

    for (let index = 0; index < 250; index += 1) {
      emitDiagnosticEvent({
        type: "model.call.started",
        runId: `run-${index}`,
        callId: `call-${index}`,
        provider: "openai",
        model: "gpt-5.4",
      });
    }

    await waitForDiagnosticEventsDrained();

    expect(events).toHaveLength(250);
  });

  it("does not extend a drain barrier for events queued after it starts", async () => {
    const callIds: string[] = [];
    onDiagnosticEvent((event) => {
      if (event.type === "model.call.started") {
        callIds.push(event.callId);
      }
    });

    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-before-barrier",
      callId: "before-barrier",
      provider: "openai",
      model: "gpt-5.4",
    });
    const drained = waitForDiagnosticEventsDrained();
    for (let index = 0; index < 250; index += 1) {
      emitDiagnosticEvent({
        type: "model.call.started",
        runId: `run-after-${index}`,
        callId: `after-${index}`,
        provider: "openai",
        model: "gpt-5.4",
      });
    }

    await drained;

    expect(callIds).toHaveLength(100);
    expect(callIds[0]).toBe("before-barrier");
    expect(
      hasPendingInternalDiagnosticEvent(
        (event) => event.type === "model.call.started" && event.callId === "after-249",
      ),
    ).toBe(true);

    await waitForDiagnosticEventsDrained();
    expect(callIds).toHaveLength(251);
  });

  it("reports pending async diagnostic events before they drain", async () => {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-pending",
      toolName: "exec",
      toolCallId: "call-pending",
      durationMs: 1,
      errorCategory: "test",
    });

    expect(
      hasPendingInternalDiagnosticEvent(
        (event, metadata) =>
          metadata.trusted &&
          event.type === "tool.execution.error" &&
          event.toolCallId === "call-pending",
      ),
    ).toBe(true);

    await waitForDiagnosticEventsDrained();

    expect(
      hasPendingInternalDiagnosticEvent((event) => event.type === "tool.execution.error"),
    ).toBe(false);
  });

  it("passes immutable pending diagnostic copies to queue inspectors", async () => {
    const events: DiagnosticEventPayload[] = [];
    onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-immutable",
      toolName: "exec",
      toolCallId: "call-immutable",
      durationMs: 1,
      errorCategory: "test",
    });

    let mutationErrors = 0;
    expect(
      hasPendingInternalDiagnosticEvent((event, metadata) => {
        try {
          (event as { type: string }).type = "model.usage";
        } catch {
          mutationErrors += 1;
        }
        try {
          (metadata as { trusted: boolean }).trusted = false;
        } catch {
          mutationErrors += 1;
        }
        return (
          metadata.trusted &&
          event.type === "tool.execution.error" &&
          event.toolCallId === "call-immutable"
        );
      }),
    ).toBe(true);
    expect(mutationErrors).toBe(2);

    await waitForDiagnosticEventsDrained();

    expect(events).toMatchObject([
      {
        type: "tool.execution.error",
        toolCallId: "call-immutable",
      },
    ]);
  });

  it("skips uncloneable pending diagnostics during queue inspection", async () => {
    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-uncloneable",
      callId: "call-uncloneable",
      provider: "openai",
      model: "gpt-5.4",
      badValue: () => undefined,
    } as never);
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-cloneable",
      toolName: "exec",
      toolCallId: "call-cloneable",
      durationMs: 1,
      errorCategory: "test",
    });

    expect(
      hasPendingInternalDiagnosticEvent(
        (event, metadata) =>
          metadata.trusted &&
          event.type === "tool.execution.error" &&
          event.toolCallId === "call-cloneable",
      ),
    ).toBe(true);
  });

  it("preserves trusted lifecycle terminals when the async queue is full", async () => {
    const events: DiagnosticEventPayload[] = [];
    onInternalDiagnosticEvent((event) => {
      events.push(event);
    });
    const model = {
      runId: "run-model",
      callId: "call-model",
      provider: "openai",
      model: "gpt-5.4",
    };
    const harness = { runId: "run-harness", harnessId: "harness" };
    const terminalEvents: Array<Parameters<typeof emitTrustedDiagnosticEvent>[0]> = [
      { type: "tool.execution.completed", toolName: "exec", durationMs: 1 },
      { type: "tool.execution.error", toolName: "exec", durationMs: 1, errorCategory: "test" },
      { type: "model.call.completed", ...model, durationMs: 1 },
      { type: "model.call.error", ...model, durationMs: 1, errorCategory: "test" },
      { type: "harness.run.completed", ...harness, durationMs: 1, outcome: "completed" },
      {
        type: "harness.run.error",
        ...harness,
        durationMs: 1,
        phase: "resolve",
        errorCategory: "test",
      },
    ];

    emitTrustedDiagnosticEvent(terminalEvents[0]!);

    for (let index = 0; index < 9_999; index += 1) {
      emitDiagnosticEvent({
        type: "model.call.started",
        runId: `saturation-run-${index}`,
        callId: `saturation-call-${index}`,
        provider: "openai",
        model: "gpt-5.4",
      });
    }
    for (const terminalEvent of terminalEvents.slice(1)) {
      emitTrustedDiagnosticEvent(terminalEvent);
    }

    expect(
      hasPendingInternalDiagnosticEvent(
        (event, metadata) => metadata.trusted && event.type === "harness.run.error",
      ),
    ).toBe(true);

    await waitForDiagnosticEventsDrained();

    for (const terminalEvent of terminalEvents) {
      expect(events).toContainEqual(expect.objectContaining(terminalEvent));
    }
    expect(
      events.filter(
        (event) => event.type === "model.call.started" && event.runId.startsWith("saturation-run-"),
      ),
    ).toHaveLength(9_994);
  });

  it("emits a bounded summary when async diagnostics are dropped at saturation", async () => {
    const events: DiagnosticEventPayload[] = [];
    onDiagnosticEvent((event) => {
      events.push(event);
    });

    for (let index = 0; index < 10_001; index += 1) {
      emitDiagnosticEvent({
        type: "model.call.started",
        runId: `drop-run-${index}`,
        callId: `drop-call-${index}`,
        provider: "openai",
        model: "gpt-5.4",
      });
    }

    await waitForDiagnosticEventsDrained();

    const dropSummary = events.find(
      (
        event,
      ): event is Extract<DiagnosticEventPayload, { type: "diagnostic.async_queue.dropped" }> =>
        event.type === "diagnostic.async_queue.dropped",
    );
    expect(dropSummary).toMatchObject({
      type: "diagnostic.async_queue.dropped",
      droppedEvents: 1,
      droppedUntrustedEvents: 1,
      maxQueueLength: 10_000,
      drainBatchSize: 100,
    });
    expect(events.filter((event) => event.type === "model.call.started")).toHaveLength(10_000);
  });

  it("keeps log records off the public diagnostic event stream", async () => {
    const publicEvents: string[] = [];
    const internalEvents: string[] = [];
    onDiagnosticEvent((event) => {
      publicEvents.push(event.type);
    });
    onInternalDiagnosticEvent((event) => {
      internalEvents.push(event.type);
    });

    emitDiagnosticEvent({
      type: "log.record",
      level: "INFO",
      message: "private log",
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(publicEvents).toStrictEqual([]);
    expect(internalEvents).toEqual(["log.record"]);
  });

  it("emits exec approval followup suppression events on the public stream", async () => {
    const events: DiagnosticEventPayload[] = [];
    onDiagnosticEvent((event) => {
      events.push(event);
    });

    emitDiagnosticEvent({
      type: "exec.approval.followup_suppressed",
      approvalId: "approval-123",
      reason: "session_rebound",
      phase: "gateway_preflight",
    });

    await waitForDiagnosticEventsDrained();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "exec.approval.followup_suppressed",
        approvalId: "approval-123",
        reason: "session_rebound",
        phase: "gateway_preflight",
        ts: expect.any(Number),
      }),
    );
  });

  it("keeps trusted private data off shared internal diagnostic listeners", async () => {
    const internalEvents: DiagnosticEventPayload[] = [];
    const trustedEvents: Array<{
      event: DiagnosticEventPayload;
      privateData: unknown;
    }> = [];
    onInternalDiagnosticEvent((event) => {
      internalEvents.push(event);
    });
    onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      trustedEvents.push({ event, privateData });
    });

    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.call.started",
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
      },
      {
        modelContent: {
          inputMessages: ["secret prompt"],
          systemPrompt: "secret system",
        },
      },
    );

    await waitForDiagnosticEventsDrained();

    expect(JSON.stringify(internalEvents)).not.toContain("secret");
    expect(JSON.stringify(trustedEvents[0]?.event)).not.toContain("secret");
    expect(trustedEvents[0]?.privateData).toEqual({
      modelContent: {
        inputMessages: ["secret prompt"],
        systemPrompt: "secret system",
      },
    });
  });

  it("skips event enrichment and subscribers when diagnostics are disabled", () => {
    const nowSpy = vi.spyOn(Date, "now");
    const seen: string[] = [];
    onDiagnosticEvent((event) => {
      seen.push(event.type);
    });
    setDiagnosticsEnabledForProcess(false);

    emitDiagnosticEvent({
      type: "webhook.received",
      channel: "telegram",
    });

    expect(seen).toStrictEqual([]);
    expect(nowSpy).not.toHaveBeenCalled();
  });

  it("drops recursive emissions after the guard threshold", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    onDiagnosticEvent(() => {
      calls += 1;
      emitDiagnosticEvent({
        type: "queue.lane.enqueue",
        lane: "main",
        queueSize: calls,
      });
    });

    emitDiagnosticEvent({
      type: "queue.lane.enqueue",
      lane: "main",
      queueSize: 0,
    });

    expect(calls).toBe(101);
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
      "[diagnostic-events] recursion guard tripped at depth=101, dropping type=queue.lane.enqueue",
    );
  });

  it("enables diagnostics unless explicitly disabled", () => {
    expect(isDiagnosticsEnabled()).toBe(true);
    expect(isDiagnosticsEnabled({} as never)).toBe(true);
    expect(isDiagnosticsEnabled({ diagnostics: {} } as never)).toBe(true);
    expect(isDiagnosticsEnabled({ diagnostics: { enabled: false } } as never)).toBe(false);
    expect(isDiagnosticsEnabled({ diagnostics: { enabled: true } } as never)).toBe(true);
  });
});
