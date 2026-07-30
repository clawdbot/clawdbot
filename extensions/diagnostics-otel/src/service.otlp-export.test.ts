// Boundary test: unlike service.test.ts this file does NOT mock @opentelemetry/api,
// so the real OTel SDK and OTLP/protobuf exporter run against a local receiver.
//
// This is the only place the two id spaces stay distinct. The mocked suite makes
// every span report the same trace id it feeds in, which hides a parent lookup
// keyed by OTel ids but queried with diagnostic ids. Assert on exported bytes here.
import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  emitTrustedDiagnosticEventWithPrivateData,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { onTrustedInternalDiagnosticEvent } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, expect, test } from "vitest";
import type { OpenClawPluginServiceContext } from "../api.js";
import { createDiagnosticsOtelService } from "./service.js";

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

afterEach(() => {
  resetDiagnosticEventsForTest();
});

test("exports a turn as one nested trace through the real OTLP exporter", async () => {
  const exported: ExportedSpan[] = [];
  const { server, port } = await startOtlpReceiver(exported);
  const service = createDiagnosticsOtelService();
  const ctx = {
    config: {
      diagnostics: {
        enabled: true,
        otel: {
          enabled: true,
          endpoint: `http://127.0.0.1:${port}`,
          protocol: "http/protobuf",
          traces: true,
          metrics: false,
          logs: false,
        },
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    stateDir: "/tmp/openclaw-diagnostics-otel-otlp-export-test",
    internalDiagnostics: {
      emit: emitTrustedDiagnosticEventWithPrivateData,
      onEvent: onTrustedInternalDiagnosticEvent,
    },
  } as unknown as OpenClawPluginServiceContext;

  try {
    await service.start(ctx);

    const runTrace = createChildDiagnosticTraceContext(createDiagnosticTraceContext());
    const base = { runId: "run-otlp-1", provider: "openai", model: "gpt-5.6-luna" };

    emitTrustedDiagnosticEventWithPrivateData(
      { type: "run.started", ...base, trace: runTrace },
      {},
    );
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.call.completed",
        ...base,
        callId: "call-1",
        durationMs: 1_200,
        trace: createChildDiagnosticTraceContext(runTrace),
      },
      {},
    );
    await waitForDiagnosticEventsDrained();

    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "run.completed",
        ...base,
        outcome: "completed",
        durationMs: 9_000,
        trace: runTrace,
      },
      {},
    );

    // Stragglers dispatch after run.completed already ended the parent span. They
    // must still join its trace instead of each minting a fresh single-span trace.
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "tool.execution.completed",
        runId: base.runId,
        toolName: "write",
        durationMs: 120,
        trace: createChildDiagnosticTraceContext(runTrace),
      },
      {},
    );
    await waitForDiagnosticEventsDrained();

    await service.stop?.(ctx);

    const runSpan = exported.find((span) => span.name === "openclaw.run");
    expect(runSpan).toBeDefined();
    expect(exported.length).toBeGreaterThanOrEqual(3);
    expect(new Set(exported.map((span) => span.traceId)).size).toBe(1);
    // Diagnostic ids must never leak into exported OTel ids.
    expect(runSpan?.traceId).not.toBe(runTrace.traceId);
    for (const span of exported) {
      if (span.name === "openclaw.run") {
        continue;
      }
      expect(span.parentSpanId).toBe(runSpan?.spanId);
    }
  } finally {
    await stopServer(server);
  }
}, 30_000);
