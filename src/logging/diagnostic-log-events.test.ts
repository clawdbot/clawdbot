// Diagnostic log event tests cover structured events written to diagnostic logs.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  resetDiagnosticTraceContextForTest,
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { getChildLogger, resetLogger, setLoggerOverride } from "./logger.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const PROTO_KEY = "__proto__";

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

beforeEach(() => {
  resetDiagnosticEventsForTest();
  resetLogger();
  setLoggerOverride({ level: "info" });
});

afterEach(() => {
  resetDiagnosticEventsForTest();
  resetDiagnosticTraceContextForTest();
  setLoggerOverride(null);
  resetLogger();
});

describe("diagnostic log events", () => {
  it("emits structured log records through diagnostics", async () => {
    const received: Array<{
      event: Extract<DiagnosticEventPayload, { type: "log.record" }>;
      metadata: DiagnosticEventMetadata;
    }> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt, metadata) => {
      if (evt.type === "log.record") {
        received.push({ event: evt, metadata });
      }
    });

    const logger = getChildLogger({
      subsystem: "diagnostic",
      trace: { traceId: TRACE_ID, spanId: SPAN_ID },
    });
    logger.info({ runId: "run-1" }, "hello diagnostic logs");
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(1);
    const [record] = received;
    if (!record) {
      throw new Error("missing diagnostic log event");
    }
    const { event, metadata } = record;
    expect(event.type).toBe("log.record");
    expect(event.level).toBe("INFO");
    expect(event.message).toBe("hello diagnostic logs");
    expect(event.attributes).toStrictEqual({
      subsystem: "diagnostic",
      runId: "run-1",
    });
    expect(event.trace).toStrictEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
    });
    expect(metadata.trusted).toBe(false);
    expect(metadata.trustedTraceContext).toBeUndefined();
  });

  it("uses active request trace context for unbound log records", async () => {
    const trace = createDiagnosticTraceContext({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
    });
    const received: Array<{
      event: Extract<DiagnosticEventPayload, { type: "log.record" }>;
      metadata: DiagnosticEventMetadata;
    }> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt, metadata) => {
      if (evt.type === "log.record") {
        received.push({ event: evt, metadata });
      }
    });

    runWithDiagnosticTraceContext(trace, () => {
      const logger = getChildLogger({ subsystem: "diagnostic" });
      logger.info({ runId: "run-1" }, "request-scoped diagnostic log");
    });
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]?.event.trace).toEqual(trace);
    expect(received[0]?.metadata.trusted).toBe(false);
    expect(received[0]?.metadata.trustedTraceContext).toBe(true);
  });

  it("redacts and bounds internal log records before diagnostic emission", async () => {
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "log.record") {
        received.push(evt);
      }
    });

    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456"; // pragma: allowlist secret
    const logger = getChildLogger({
      subsystem: "diagnostic",
      trace: { traceId: TRACE_ID, spanId: SPAN_ID },
    });
    logger.info(
      {
        token: secret,
        longValue: "x".repeat(5000),
        nested: { secret },
        "bad key": "drop-me",
      },
      { raw: secret },
      `secret=${secret} ${"y".repeat(5000)}`,
    );
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(1);
    const [event] = received;
    expect(expectDefined(event, "event test invariant").message).not.toContain(secret);
    expect(expectDefined(event, "event test invariant").message.length).toBeLessThanOrEqual(4200);
    expect(expectDefined(event, "event test invariant").attributes?.token).not.toBe(secret);
    expect(String(expectDefined(event, "event test invariant").attributes?.token)).toContain("…");
    expect(
      String(expectDefined(event, "event test invariant").attributes?.longValue).length,
    ).toBeLessThanOrEqual(2100);
    expect(
      Object.hasOwn(expectDefined(event, "event test invariant").attributes ?? {}, "nested"),
    ).toBe(false);
    expect(
      Object.hasOwn(expectDefined(event, "event test invariant").attributes ?? {}, "bad key"),
    ).toBe(false);
    expect(Object.hasOwn(expectDefined(event, "event test invariant"), "argsJson")).toBe(false);
  });

  it("keeps bounded diagnostic messages UTF-16 safe", async () => {
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "log.record") {
        received.push(event);
      }
    });
    const prefix = "x".repeat(4_095);

    getChildLogger({ subsystem: "diagnostic" }).info(`${prefix}😀tail`);
    await flushDiagnosticEvents();
    unsubscribe();

    // The post-redaction bound keeps the first dot from the initial truncation marker.
    expect(received.at(-1)?.message).toBe(`${prefix}....(truncated)`);
  });

  it("drops sensitive, blocked, and excess log attribute keys without copying large objects", async () => {
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "log.record") {
        received.push(evt);
      }
    });

    const structured = Object.create(null) as Record<string, unknown>;
    structured.safe = "ok";
    structured[PROTO_KEY] = "pollute";
    structured["constructor"] = "pollute";
    structured["prototype"] = "pollute";
    structured["sk-1234567890abcdef1234567890abcdef"] = "secret-key"; // pragma: allowlist secret
    for (let index = 0; index < 1000; index += 1) {
      structured[`extra${index}`] = index;
    }

    const logger = getChildLogger({
      subsystem: "diagnostic",
      trace: { traceId: TRACE_ID, spanId: SPAN_ID },
    });
    logger.info(structured, "bounded attrs");
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(1);
    expect(expectDefined(received[0], "received[0] test invariant").attributes?.safe).toBe("ok");
    expect(
      Object.keys(expectDefined(received[0], "received[0] test invariant").attributes ?? {}),
    ).toHaveLength(32);
    const attributes = expectDefined(received[0], "received[0] test invariant").attributes ?? {};
    expect(Object.hasOwn(attributes, PROTO_KEY)).toBe(false);
    expect(Object.hasOwn(attributes, "constructor")).toBe(false);
    expect(Object.hasOwn(attributes, "prototype")).toBe(false);
    expect(Object.hasOwn(attributes, "sk-1234567890abcdef1234567890abcdef")).toBe(false); // pragma: allowlist secret
  });
});
