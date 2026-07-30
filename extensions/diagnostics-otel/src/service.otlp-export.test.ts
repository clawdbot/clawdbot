// Boundary test: unlike service.test.ts this file does NOT mock @opentelemetry/api,
// so the real OTel SDK and OTLP/protobuf exporter run against a local receiver.
//
// It exists because the mocked suite makes every span report back the same trace id
// the test feeds in, collapsing the diagnostic and OTel id spaces into one value. That
// hides a parent lookup keyed by one id space and queried with the other, so the only
// way to catch that class of bug is to assert on the exported bytes.
import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  emitTrustedDiagnosticEventWithPrivateData,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, expect, test } from "vitest";
import { startOtelService, stopStartedOtelServices } from "./service.test-helpers.js";

type ExportedSpan = { traceId: string; spanId: string; parentSpanId: string; name: string };

function readVarint(buf: Buffer, start: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let i = start;
  while (i < buf.length) {
    const byte = buf[i] as number;
    result |= BigInt(byte & 0x7f) << shift;
    i += 1;
    if ((byte & 0x80) === 0) {
      return [result, i - start];
    }
    shift += 7n;
    if (shift > 70n) {
      return [0n, 0];
    }
  }
  return [0n, 0];
}

/** Walks protobuf wire format, yielding [fieldNumber, isLengthDelimited, bytes]. */
function* protoFields(buf: Buffer): Generator<[number, boolean, Buffer]> {
  let i = 0;
  while (i < buf.length) {
    const [tag, tagLen] = readVarint(buf, i);
    if (tagLen === 0) {
      return;
    }
    i += tagLen;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (wireType === 2) {
      const [len, lenLen] = readVarint(buf, i);
      i += lenLen;
      const end = i + Number(len);
      yield [fieldNumber, true, buf.subarray(i, end)];
      i = end;
    } else if (wireType === 0) {
      const [, valLen] = readVarint(buf, i);
      i += valLen;
    } else if (wireType === 1) {
      i += 8;
    } else if (wireType === 5) {
      i += 4;
    } else {
      return;
    }
  }
}

function nestedMessages(buf: Buffer, fieldNumber: number): Buffer[] {
  const out: Buffer[] = [];
  for (const [field, isLengthDelimited, value] of protoFields(buf)) {
    if (field === fieldNumber && isLengthDelimited) {
      out.push(value);
    }
  }
  return out;
}

/** Decodes ExportTraceServiceRequest down to span identity fields. */
function decodeExportedSpans(buf: Buffer): ExportedSpan[] {
  const spans: ExportedSpan[] = [];
  for (const resourceSpans of nestedMessages(buf, 1)) {
    for (const scopeSpans of nestedMessages(resourceSpans, 2)) {
      for (const raw of nestedMessages(scopeSpans, 2)) {
        const span: ExportedSpan = { traceId: "", spanId: "", parentSpanId: "", name: "" };
        for (const [field, isLengthDelimited, value] of protoFields(raw)) {
          if (!isLengthDelimited) {
            continue;
          }
          if (field === 1) {
            span.traceId = value.toString("hex");
          } else if (field === 2) {
            span.spanId = value.toString("hex");
          } else if (field === 4) {
            span.parentSpanId = value.toString("hex");
          } else if (field === 5) {
            span.name = value.toString("utf8");
          }
        }
        if (span.name) {
          spans.push(span);
        }
      }
    }
  }
  return spans;
}

async function startOtlpReceiver(exported: ExportedSpan[]) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") {
        try {
          body = gunzipSync(body);
        } catch {
          // Undecodable payloads simply contribute no spans.
        }
      }
      if (req.url?.includes("/v1/traces")) {
        exported.push(...decodeExportedSpans(body));
      }
      res.writeHead(200, { "content-type": "application/x-protobuf" });
      res.end(Buffer.alloc(0));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function stopServer(server: Server) {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

// This file starts a real NodeSDK, which registers a global tracer provider and a
// live BatchSpanProcessor. Vitest runs with isolate=false, so an assertion failure
// must not leave either behind for sibling files.
afterEach(async () => {
  await stopStartedOtelServices();
  resetDiagnosticEventsForTest();
});

// Covers all three completeTrackedLifecycleSpan owners at the real export boundary:
// run.completed, harness.run.completed, and message.processed. The mocked suite cannot
// tell the two id spaces apart, so a regression at any one of them is only visible here.
test("exports a turn as one nested trace through the real OTLP exporter", async () => {
  const exported: ExportedSpan[] = [];
  const { server, port } = await startOtlpReceiver(exported);
  // startOtelService owns the typed context and registers the service for teardown.
  const { service, ctx } = await startOtelService({
    endpoint: `http://127.0.0.1:${port}`,
    traces: true,
  });

  try {
    const emit = (event: Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0]) =>
      emitTrustedDiagnosticEventWithPrivateData(event, {});

    const messageTrace = createDiagnosticTraceContext();
    const harnessTrace = createChildDiagnosticTraceContext(messageTrace);
    const runTrace = createChildDiagnosticTraceContext(harnessTrace);
    const base = { runId: "run-otlp-1", provider: "openai", model: "gpt-5.6-luna" };
    const harnessBase = { ...base, harnessId: "claude-cli" };

    emit({
      type: "message.dispatch.started",
      channel: "telegram",
      source: "webhook",
      trace: messageTrace,
    });
    emit({ type: "harness.run.started", ...harnessBase, trace: harnessTrace });
    emit({ type: "run.started", ...base, trace: runTrace });
    emit({
      type: "model.call.completed",
      ...base,
      callId: "call-1",
      durationMs: 1_200,
      trace: createChildDiagnosticTraceContext(runTrace),
    });
    await waitForDiagnosticEventsDrained();

    // Each lifecycle span below ends, then receives a straggler. Those stragglers must
    // join the same trace instead of each minting a fresh single-span trace.
    emit({
      type: "run.completed",
      ...base,
      outcome: "completed",
      durationMs: 9_000,
      trace: runTrace,
    });
    emit({
      type: "tool.execution.completed",
      runId: base.runId,
      toolName: "write",
      durationMs: 120,
      trace: createChildDiagnosticTraceContext(runTrace),
    });

    emit({
      type: "harness.run.completed",
      ...harnessBase,
      outcome: "completed",
      durationMs: 9_500,
      trace: harnessTrace,
    });
    emit({
      type: "context.assembled",
      ...base,
      sessionKey: "session-key",
      channel: "telegram",
      trigger: "message",
      messageCount: 3,
      historyTextChars: 100,
      historyImageBlocks: 0,
      maxMessageTextChars: 100,
      systemPromptChars: 50,
      promptChars: 150,
      promptImages: 0,
      trace: createChildDiagnosticTraceContext(harnessTrace),
    });

    emit({
      type: "message.processed",
      channel: "telegram",
      outcome: "completed",
      durationMs: 10_000,
      trace: messageTrace,
    });
    emit({
      type: "model.usage",
      ...base,
      usage: { input: 10, output: 5, total: 15 },
      durationMs: 30,
      trace: createChildDiagnosticTraceContext(messageTrace),
    });
    await waitForDiagnosticEventsDrained();

    await service.stop?.(ctx);

    // Scope to the spans this turn emits: ambient spans such as
    // openclaw.diagnostic.phase are roots by design and would otherwise read as a
    // second trace and fail this as a flake.
    const turnSpanNames = new Set([
      "openclaw.message.processed",
      "openclaw.harness.run",
      "openclaw.run",
      "openclaw.model.call",
      "openclaw.tool.execution",
      "openclaw.context.assembled",
      "openclaw.model.usage",
    ]);
    const turnSpans = exported.filter((span) => turnSpanNames.has(span.name));
    const spanByName = (name: string) => turnSpans.find((span) => span.name === name);
    const messageSpan = spanByName("openclaw.message.processed");
    const harnessSpan = spanByName("openclaw.harness.run");
    const runSpan = spanByName("openclaw.run");

    expect(turnSpans).toHaveLength(7);
    expect(new Set(turnSpans.map((span) => span.traceId)).size).toBe(1);
    // A run with no exported ancestor starts a fresh OTel root rather than reusing the
    // diagnostic trace id. Spans parented from an upstream traceparent do adopt it.
    expect(messageSpan?.traceId).not.toBe(messageTrace.traceId);
    expect(messageSpan?.parentSpanId).toBe("");
    expect(harnessSpan?.parentSpanId).toBe(messageSpan?.spanId);
    expect(runSpan?.parentSpanId).toBe(harnessSpan?.spanId);
    // Stragglers land on the lifecycle span that owned them, not on a new root.
    expect(spanByName("openclaw.tool.execution")?.parentSpanId).toBe(runSpan?.spanId);
    expect(spanByName("openclaw.context.assembled")?.parentSpanId).toBe(harnessSpan?.spanId);
    expect(spanByName("openclaw.model.usage")?.parentSpanId).toBe(messageSpan?.spanId);
  } finally {
    await stopServer(server);
  }
}, 30_000);
