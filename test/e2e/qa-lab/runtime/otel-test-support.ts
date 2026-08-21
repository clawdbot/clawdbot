import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { gunzipSync } from "node:zlib";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { DiagnosticTraceContext } from "openclaw/plugin-sdk/diagnostic-runtime";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "../../../../src/agents/embedded-agent-runner/run/attempt.model-diagnostic-events.js";

export type OtlpSignal = "logs" | "metrics" | "traces";

type OtlpAnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: number | string | { toString(): string };
  doubleValue?: number;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
  bytesValue?: Uint8Array;
};

type OtlpKeyValue = {
  key?: string;
  value?: OtlpAnyValue;
};

type OtlpSpan = {
  attributes?: OtlpKeyValue[];
  endTimeMs?: number;
  name?: string;
  parentSpanId?: Uint8Array;
  spanId?: Uint8Array;
  statusCode?: number;
  traceId?: Uint8Array;
};

type OtlpScopeSpans = {
  spans?: OtlpSpan[];
};

type OtlpResourceSpans = {
  scopeSpans?: OtlpScopeSpans[];
};

export type CapturedRequest = {
  bytes: number;
  contentEncoding?: string;
  logCount: number;
  metricCount: number;
  path: string;
  receivedAtMs?: number;
  signal: OtlpSignal;
  spanCount: number;
  status: number;
};

export type CapturedSpan = {
  attributes: Record<string, string | number | boolean | string[]>;
  endTimeMs?: number;
  name: string;
  parent: boolean;
  parentSpanId?: string;
  spanId?: string;
  statusCode?: number;
  traceId?: string;
};

export type CapturedMetric = {
  name: string;
};

export type CapturedLogRecord = {
  body: string | number | boolean | string[];
  spanId: string;
  traceId: string;
};

type CapturedTraceSummary = {
  traceId: string;
  names: Record<string, number>;
};

const MAX_RECENT_TRACE_SUMMARIES = 8;
const MAX_SPAN_NAMES_PER_TRACE_SUMMARY = 16;
const OTHER_SPAN_NAME = "other";

export function createRecentTraceSummary() {
  const traces = new Map<string, Map<string, number>>();

  return {
    add(spans: readonly CapturedSpan[]): void {
      for (const span of spans) {
        const traceId = span.traceId || "missing";
        const names = traces.get(traceId) ?? new Map<string, number>();
        const name =
          names.has(span.name) || names.size < MAX_SPAN_NAMES_PER_TRACE_SUMMARY - 1
            ? span.name
            : OTHER_SPAN_NAME;
        names.set(name, (names.get(name) ?? 0) + 1);

        // Map insertion order owns recency; reinserting keeps the latest active trace last.
        traces.delete(traceId);
        traces.set(traceId, names);
        if (traces.size > MAX_RECENT_TRACE_SUMMARIES) {
          const oldestTraceId = traces.keys().next().value;
          if (oldestTraceId !== undefined) {
            traces.delete(oldestTraceId);
          }
        }
      }
    },
    read(): CapturedTraceSummary[] {
      return [...traces].map(([traceId, names]) => ({
        traceId,
        names: Object.fromEntries(names),
      }));
    },
  };
}

export function runModelCallAndCaptureTraceparent(params: {
  trace: DiagnosticTraceContext;
  runId: string;
  callId: string;
  provider: string;
  model: string;
}): string | undefined {
  let outboundTraceparent: string | undefined;
  const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
    ((
      _model: Parameters<StreamFn>[0],
      _context: Parameters<StreamFn>[1],
      options: Parameters<StreamFn>[2],
    ) => {
      outboundTraceparent = options?.headers?.traceparent;
      return undefined as never;
    }) as StreamFn,
    {
      runId: params.runId,
      provider: params.provider,
      model: params.model,
      trace: params.trace,
      nextCallId: () => params.callId,
      suppressPluginHooks: true,
    },
  );
  void wrapped({} as never, {} as never);
  return outboundTraceparent;
}

const OTLP_SIGNAL_PATHS = new Map<string, OtlpSignal>([
  ["/v1/traces", "traces"],
  ["/v1/metrics", "metrics"],
  ["/v1/logs", "logs"],
]);
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/u;
const MAX_OTLP_COMPRESSED_BODY_BYTES = readPositiveIntegerEnv(
  "OPENCLAW_QA_OTEL_MAX_COMPRESSED_BODY_BYTES",
  2 * 1024 * 1024,
);
const MAX_OTLP_DECODED_BODY_BYTES = readPositiveIntegerEnv(
  "OPENCLAW_QA_OTEL_MAX_DECODED_BODY_BYTES",
  8 * 1024 * 1024,
);
const MAX_CAPTURED_BODY_TEXT_BYTES = readPositiveIntegerEnv(
  "OPENCLAW_QA_OTEL_MAX_CAPTURED_BODY_TEXT_BYTES",
  512 * 1024,
);

export function readPositiveIntegerEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  const value = raw.trim();
  if (!POSITIVE_INTEGER_PATTERN.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return parsed;
}

function oversizedBodyError(label: string, actualBytes: number, maxBytes: number): Error {
  const error = new Error(`${label} exceeded ${maxBytes} bytes: ${actualBytes} bytes`) as Error & {
    statusCode?: number;
  };
  error.statusCode = 413;
  return error;
}

export async function readRequestBody(
  req: IncomingMessage,
  maxBytes = MAX_OTLP_COMPRESSED_BODY_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      req.destroy();
      throw oversizedBodyError("compressed OTLP request body", totalBytes, maxBytes);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function decodeRequestBody(
  body: Buffer,
  contentEncoding: string | undefined,
  maxBytes = MAX_OTLP_DECODED_BODY_BYTES,
): Buffer {
  const normalizedEncoding = contentEncoding?.trim().toLowerCase();
  if (body.length > maxBytes && (!normalizedEncoding || normalizedEncoding === "identity")) {
    throw oversizedBodyError("OTLP request body", body.length, maxBytes);
  }
  if (!normalizedEncoding || normalizedEncoding === "identity") {
    return body;
  }
  if (normalizedEncoding === "gzip") {
    let decoded: Buffer;
    try {
      decoded = gunzipSync(body, { maxOutputLength: maxBytes });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|larger than/u.test(message)) {
        throw oversizedBodyError("decoded OTLP request body", maxBytes + 1, maxBytes);
      }
      throw error;
    }
    if (decoded.length > maxBytes) {
      throw oversizedBodyError("decoded OTLP request body", decoded.length, maxBytes);
    }
    return decoded;
  }
  throw new Error(`unsupported OTLP content-encoding ${contentEncoding}`);
}

export function appendCapturedBodyText(
  capturedBodyText: Partial<Record<OtlpSignal, string[]>>,
  signal: OtlpSignal,
  body: Buffer,
  maxBytes = MAX_CAPTURED_BODY_TEXT_BYTES,
  disallowedNeedles: string[] = [],
): void {
  const currentEntries = capturedBodyText[signal] ?? [];
  const leakEntries = currentEntries.filter((entry) => entry.startsWith("[detected leak needle] "));
  const currentTail = currentEntries
    .filter((entry) => !entry.startsWith("[detected leak needle] "))
    .join("\n");
  const bodyText = body.toString("utf8");
  const next = currentTail ? `${currentTail}\n${bodyText}` : bodyText;
  const buffer = Buffer.from(next);
  const nextLeakEntries = [
    ...leakEntries,
    ...disallowedNeedles
      .filter((needle) => bodyText.includes(needle))
      .map((needle) => `[detected leak needle] ${needle}`),
  ].slice(-20);
  const tailEntry =
    buffer.length > maxBytes
      ? `[captured body text truncated to last ${maxBytes} bytes]\n${buffer
          .subarray(buffer.length - maxBytes)
          .toString("utf8")}`
      : next;
  capturedBodyText[signal] = [...nextLeakEntries, tailEntry];
}

function normalizeOtlpValue(value: OtlpAnyValue | undefined): string | number | boolean | string[] {
  if (!value) {
    return "";
  }
  if (typeof value.stringValue === "string") {
    return value.stringValue;
  }
  if (typeof value.boolValue === "boolean") {
    return value.boolValue;
  }
  if (typeof value.doubleValue === "number") {
    return value.doubleValue;
  }
  if (value.intValue !== undefined) {
    return Number(value.intValue.toString());
  }
  if (value.arrayValue?.values) {
    return value.arrayValue.values.map((entry) => String(normalizeOtlpValue(entry)));
  }
  if (value.kvlistValue?.values) {
    return value.kvlistValue.values
      .map((entry) => `${entry.key ?? ""}=${String(normalizeOtlpValue(entry.value))}`)
      .filter(Boolean);
  }
  if (value.bytesValue) {
    return Buffer.from(value.bytesValue).toString("hex");
  }
  return "";
}

function spanAttributes(span: OtlpSpan): Record<string, string | number | boolean | string[]> {
  const attributes: Record<string, string | number | boolean | string[]> = {};
  for (const attribute of span.attributes ?? []) {
    const key = attribute.key?.trim();
    if (!key) {
      continue;
    }
    attributes[key] = normalizeOtlpValue(attribute.value);
  }
  return attributes;
}

class ProtoReader {
  private offset = 0;

  constructor(private readonly buffer: Uint8Array) {}

  done(): boolean {
    return this.offset >= this.buffer.length;
  }

  tag() {
    const raw = this.varint();
    return { field: raw >>> 3, wire: raw & 0x7 };
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    while (this.offset < this.buffer.length) {
      const byte = this.buffer.at(this.offset);
      if (byte === undefined) {
        throw new Error("truncated protobuf varint");
      }
      this.offset += 1;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        return result;
      }
      shift += 7;
    }
    throw new Error("truncated protobuf varint");
  }

  bytes(): Uint8Array {
    const length = this.varint();
    const end = this.offset + length;
    if (end > this.buffer.length) {
      throw new Error("truncated protobuf bytes");
    }
    const value = this.buffer.subarray(this.offset, end);
    this.offset = end;
    return value;
  }

  string(): string {
    return new TextDecoder().decode(this.bytes());
  }

  private advance(length: number, label: string): number {
    const start = this.offset;
    const end = this.offset + length;
    if (end > this.buffer.length) {
      throw new Error(`truncated protobuf ${label}`);
    }
    this.offset = end;
    return start;
  }

  fixed64Float(): number {
    const start = this.advance(8, "fixed64");
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + start, 8);
    return view.getFloat64(0, true);
  }

  fixed64Uint(): bigint {
    const start = this.advance(8, "fixed64");
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + start, 8);
    return view.getBigUint64(0, true);
  }

  skip(wire: number): void {
    if (wire === 0) {
      this.varint();
    } else if (wire === 1) {
      this.advance(8, "fixed64");
    } else if (wire === 2) {
      this.bytes();
    } else if (wire === 5) {
      this.advance(4, "fixed32");
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
}

function decodeAnyValue(message: Uint8Array): OtlpAnyValue {
  const reader = new ProtoReader(message);
  const value: OtlpAnyValue = {};
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      value.stringValue = reader.string();
    } else if (field === 2 && wire === 0) {
      value.boolValue = reader.varint() !== 0;
    } else if (field === 3 && wire === 0) {
      value.intValue = reader.varint();
    } else if (field === 4 && wire === 1) {
      value.doubleValue = reader.fixed64Float();
    } else if (field === 5 && wire === 2) {
      value.arrayValue = decodeArrayValue(reader.bytes());
    } else if (field === 6 && wire === 2) {
      value.kvlistValue = decodeKeyValueList(reader.bytes());
    } else if (field === 7 && wire === 2) {
      value.bytesValue = reader.bytes();
    } else {
      reader.skip(wire);
    }
  }
  return value;
}

function decodeArrayValue(message: Uint8Array): { values?: OtlpAnyValue[] } {
  const reader = new ProtoReader(message);
  const values: OtlpAnyValue[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      values.push(decodeAnyValue(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  return { values };
}

function decodeKeyValue(message: Uint8Array): OtlpKeyValue {
  const reader = new ProtoReader(message);
  const entry: OtlpKeyValue = {};
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      entry.key = reader.string();
    } else if (field === 2 && wire === 2) {
      entry.value = decodeAnyValue(reader.bytes());
    } else {
      reader.skip(wire);
    }
  }
  return entry;
}

function decodeKeyValueList(message: Uint8Array): { values?: OtlpKeyValue[] } {
  const reader = new ProtoReader(message);
  const values: OtlpKeyValue[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      values.push(decodeKeyValue(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  return { values };
}

function decodeStatus(message: Uint8Array): number {
  const reader = new ProtoReader(message);
  let code = 0;
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 3 && wire === 0) {
      code = reader.varint();
    } else {
      reader.skip(wire);
    }
  }
  return code;
}

function decodeSpan(message: Uint8Array): OtlpSpan {
  const reader = new ProtoReader(message);
  const span: OtlpSpan = {};
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      span.traceId = reader.bytes();
    } else if (field === 2 && wire === 2) {
      span.spanId = reader.bytes();
    } else if (field === 4 && wire === 2) {
      span.parentSpanId = reader.bytes();
    } else if (field === 5 && wire === 2) {
      span.name = reader.string();
    } else if (field === 8 && wire === 1) {
      span.endTimeMs = Number(reader.fixed64Uint() / 1_000_000n);
    } else if (field === 9 && wire === 2) {
      span.attributes ??= [];
      span.attributes.push(decodeKeyValue(reader.bytes()));
    } else if (field === 15 && wire === 2) {
      span.statusCode = decodeStatus(reader.bytes());
    } else {
      reader.skip(wire);
    }
  }
  return span;
}

function decodeScopeSpans(message: Uint8Array): OtlpScopeSpans {
  const reader = new ProtoReader(message);
  const spans: OtlpSpan[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 2 && wire === 2) {
      spans.push(decodeSpan(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  return { spans };
}

function decodeResourceSpans(message: Uint8Array): OtlpResourceSpans {
  const reader = new ProtoReader(message);
  const scopeSpans: OtlpScopeSpans[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 2 && wire === 2) {
      scopeSpans.push(decodeScopeSpans(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  return { scopeSpans };
}

function decodeTraceRequest(body: Buffer): CapturedSpan[] {
  const reader = new ProtoReader(body);
  const resourceSpans: OtlpResourceSpans[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      resourceSpans.push(decodeResourceSpans(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  const spans: CapturedSpan[] = [];
  for (const resource of resourceSpans) {
    for (const scopeSpans of resource.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        const name = span.name?.trim();
        if (!name) {
          continue;
        }
        spans.push({
          attributes: spanAttributes(span),
          endTimeMs: span.endTimeMs,
          name,
          parent: (span.parentSpanId?.length ?? 0) > 0,
          parentSpanId: span.parentSpanId ? Buffer.from(span.parentSpanId).toString("hex") : "",
          spanId: span.spanId ? Buffer.from(span.spanId).toString("hex") : "",
          statusCode: span.statusCode ?? 0,
          traceId: span.traceId ? Buffer.from(span.traceId).toString("hex") : "",
        });
      }
    }
  }
  return spans;
}

function decodeMetric(message: Uint8Array): CapturedMetric | undefined {
  const reader = new ProtoReader(message);
  let name = "";
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      name = reader.string();
    } else {
      reader.skip(wire);
    }
  }
  const normalizedName = name.trim();
  return normalizedName ? { name: normalizedName } : undefined;
}

function decodeScopeMetrics(message: Uint8Array): CapturedMetric[] {
  const reader = new ProtoReader(message);
  const metrics: CapturedMetric[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 2 && wire === 2) {
      const metric = decodeMetric(reader.bytes());
      if (metric) {
        metrics.push(metric);
      }
    } else {
      reader.skip(wire);
    }
  }
  return metrics;
}

function decodeResourceMetrics(message: Uint8Array): CapturedMetric[] {
  const reader = new ProtoReader(message);
  const metrics: CapturedMetric[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 2 && wire === 2) {
      metrics.push(...decodeScopeMetrics(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  return metrics;
}

function decodeMetricRequest(body: Buffer): CapturedMetric[] {
  const reader = new ProtoReader(body);
  const metrics: CapturedMetric[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      metrics.push(...decodeResourceMetrics(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  return metrics;
}

function decodeLogRecord(message: Uint8Array): CapturedLogRecord {
  const reader = new ProtoReader(message);
  let body: string | number | boolean | string[] = "";
  let traceId = "";
  let spanId = "";
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 5 && wire === 2) {
      body = normalizeOtlpValue(decodeAnyValue(reader.bytes()));
    } else if (field === 9 && wire === 2) {
      traceId = Buffer.from(reader.bytes()).toString("hex");
    } else if (field === 10 && wire === 2) {
      spanId = Buffer.from(reader.bytes()).toString("hex");
    } else {
      reader.skip(wire);
    }
  }
  return { body, spanId, traceId };
}

function decodeScopeLogs(message: Uint8Array): CapturedLogRecord[] {
  const reader = new ProtoReader(message);
  const records: CapturedLogRecord[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 2 && wire === 2) {
      records.push(decodeLogRecord(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  return records;
}

function decodeResourceLogs(message: Uint8Array): CapturedLogRecord[] {
  const reader = new ProtoReader(message);
  const records: CapturedLogRecord[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 2 && wire === 2) {
      records.push(...decodeScopeLogs(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  return records;
}

function decodeLogRequest(body: Buffer): CapturedLogRecord[] {
  const reader = new ProtoReader(body);
  const records: CapturedLogRecord[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      records.push(...decodeResourceLogs(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  return records;
}

function closeLocalOtlpReceiverConnections(
  server: ReturnType<typeof createServer>,
  sockets: Set<Socket>,
): void {
  for (const socket of sockets) {
    socket.destroy();
  }
  server.closeAllConnections();
}

export function startLocalOtlpReceiver(disallowedBodyNeedles: string[] = []) {
  const capturedRequests: CapturedRequest[] = [];
  const capturedSpans: CapturedSpan[] = [];
  const capturedMetrics: CapturedMetric[] = [];
  const capturedLogRecords: CapturedLogRecord[] = [];
  const capturedBodyText: Partial<Record<OtlpSignal, string[]>> = {};
  const recentTraceSummary = createRecentTraceSummary();
  const sockets = new Set<Socket>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.method !== "POST" || !req.url) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const requestPath = req.url;
      const signal = OTLP_SIGNAL_PATHS.get(requestPath);
      if (!signal) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }

      const contentEncoding = headerValue(req.headers["content-encoding"]);
      let body: Buffer;
      try {
        body = decodeRequestBody(await readRequestBody(req), contentEncoding);
      } catch (error) {
        const statusCode =
          typeof (error as { statusCode?: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : 400;
        capturedRequests.push({
          path: requestPath,
          signal,
          bytes: 0,
          contentEncoding,
          status: statusCode,
          spanCount: 0,
          metricCount: 0,
          logCount: 0,
        });
        res.writeHead(statusCode, { "content-type": "text/plain" });
        res.end(error instanceof Error ? error.message : String(error));
        return;
      }
      let spans: CapturedSpan[];
      let metrics: CapturedMetric[];
      let logRecords: CapturedLogRecord[];
      try {
        spans = signal === "traces" ? decodeTraceRequest(body) : [];
        metrics = signal === "metrics" ? decodeMetricRequest(body) : [];
        logRecords = signal === "logs" ? decodeLogRequest(body) : [];
        appendCapturedBodyText(capturedBodyText, signal, body, undefined, disallowedBodyNeedles);
      } catch (error) {
        appendCapturedBodyText(capturedBodyText, signal, body, undefined, disallowedBodyNeedles);
        capturedRequests.push({
          path: requestPath,
          signal,
          bytes: body.length,
          contentEncoding,
          status: 400,
          spanCount: 0,
          metricCount: 0,
          logCount: 0,
        });
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(error instanceof Error ? error.message : String(error));
        return;
      }
      capturedSpans.push(...spans);
      recentTraceSummary.add(spans);
      capturedMetrics.push(...metrics);
      capturedLogRecords.push(...logRecords);
      capturedRequests.push({
        path: requestPath,
        signal,
        bytes: body.length,
        contentEncoding,
        receivedAtMs: Date.now(),
        status: 200,
        spanCount: spans.length,
        metricCount: metrics.length,
        logCount: logRecords.length,
      });
      res.writeHead(200, { "content-type": "application/x-protobuf" });
      res.end();
    })();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  let closePromise: Promise<void> | undefined;

  return {
    capturedRequests,
    capturedSpans,
    capturedMetrics,
    capturedLogRecords,
    capturedBodyText,
    recentTraceSummary: recentTraceSummary.read,
    async listen(): Promise<number> {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to bind local OTLP receiver");
      }
      return address.port;
    },
    async close(): Promise<void> {
      closePromise ??= new Promise<void>((resolve, reject) => {
        closeLocalOtlpReceiverConnections(server, sockets);
        server.close((error) => (error ? reject(error) : resolve()));
        closeLocalOtlpReceiverConnections(server, sockets);
      });
      await closePromise;
    },
  };
}
