#!/usr/bin/env -S node --import tsx
// Qa Otel Smoke script supports OpenClaw repository automation.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { stripLeadingPackageManagerSeparator } from "./lib/arg-utils.mjs";

type CollectorMode = "local" | "docker";

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
  name?: string;
  parentSpanId?: Uint8Array;
  attributes?: OtlpKeyValue[];
};

type OtlpScopeSpans = {
  spans?: OtlpSpan[];
};

type OtlpResourceSpans = {
  scopeSpans?: OtlpScopeSpans[];
};

type OtlpSignal = "logs" | "metrics" | "traces";

type CliOptions = {
  collectorMode: CollectorMode;
  outputDir: string;
  providerMode: string;
  scenarioId: string;
  primaryModel?: string;
  alternateModel?: string;
  help: boolean;
};

type CapturedRequest = {
  path: string;
  signal: OtlpSignal;
  bytes: number;
  contentEncoding?: string;
  status: number;
  spanCount: number;
  metricCount: number;
  logCount: number;
};

type CapturedSpan = {
  name: string;
  parent: boolean;
  attributes: Record<string, string | number | boolean | string[]>;
};

type CapturedMetric = {
  name: string;
};

type CapturedLogRecord = {
  body: string | number | boolean | string[];
};

const DEFAULT_SCENARIO_ID = "otel-trace-smoke";
const DEFAULT_DOCKER_COLLECTOR_IMAGE =
  process.env.OPENCLAW_QA_OTEL_COLLECTOR_IMAGE || "otel/opentelemetry-collector:0.104.0";
const OTLP_SIGNAL_PATHS = new Map<string, OtlpSignal>([
  ["/v1/traces", "traces"],
  ["/v1/metrics", "metrics"],
  ["/v1/logs", "logs"],
]);
const REQUIRED_SPAN_NAMES = [
  "openclaw.run",
  "openclaw.harness.run",
  "openclaw.context.assembled",
  "openclaw.message.delivery",
] as const;
const REQUIRED_METRIC_NAMES = ["openclaw.harness.duration_ms"] as const;
const DISALLOWED_ATTRIBUTE_KEYS = new Set([
  "openclaw.runId",
  "openclaw.chatId",
  "openclaw.messageId",
  "openclaw.sessionKey",
  "openclaw.sessionId",
  "openclaw.callId",
  "openclaw.toolCallId",
  "openclaw.run_id",
  "openclaw.chat_id",
  "openclaw.message_id",
  "openclaw.session_key",
  "openclaw.session_id",
  "openclaw.call_id",
  "openclaw.tool_call_id",
]);
const DISALLOWED_BODY_NEEDLES = ["OTEL-QA-SECRET", "OTEL-QA-OK"];
const COLLECTOR_OUTPUT_TAIL_BYTES = 16_000;
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
const QA_SUITE_TIMEOUT_MS = readPositiveIntegerEnv(
  "OPENCLAW_QA_OTEL_SUITE_TIMEOUT_MS",
  10 * 60 * 1000,
);
const QA_SUITE_KILL_GRACE_MS = readPositiveIntegerEnv("OPENCLAW_QA_OTEL_SUITE_KILL_GRACE_MS", 5000);

function readPositiveIntegerEnv(
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

function oversizedBodyError(
  label: string,
  actualBytes: number,
  maxBytes: number,
): Error & {
  statusCode: number;
} {
  return Object.assign(new Error(`${label} exceeded ${maxBytes} bytes: ${actualBytes} bytes`), {
    statusCode: 413,
  });
}

function usage(): string {
  return `Usage: pnpm qa:otel:smoke [--collector local|docker] [--output-dir <path>] [--provider-mode <mode>] [--scenario <id>] [--model <ref>] [--alt-model <ref>]

Runs a QA-lab scenario with diagnostics-otel enabled, then asserts the emitted
signal shape and privacy contract. The default collector is an in-process
OTLP/HTTP receiver. Use --collector docker to put a real OpenTelemetry
Collector container in front of the receiver.
`;
}

function parseArgs(argv: string[]): CliOptions {
  const args = stripLeadingPackageManagerSeparator(argv);
  const options: CliOptions = {
    collectorMode: "local",
    outputDir: path.join(".artifacts", "qa-e2e", `otel-smoke-${Date.now().toString(36)}`),
    providerMode: "mock-openai",
    scenarioId: DEFAULT_SCENARIO_ID,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const readValue = () => {
      const value = args[index + 1]?.trim();
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--output-dir") {
      options.outputDir = readValue();
    } else if (arg === "--collector") {
      const value = readValue();
      if (value !== "local" && value !== "docker") {
        throw new Error(`--collector must be local or docker, got ${JSON.stringify(value)}`);
      }
      options.collectorMode = value;
    } else if (arg === "--provider-mode") {
      options.providerMode = readValue();
    } else if (arg === "--scenario") {
      options.scenarioId = readValue();
    } else if (arg === "--model") {
      options.primaryModel = readValue();
    } else if (arg === "--alt-model") {
      options.alternateModel = readValue();
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function disallowedBodyNeedles(options: CliOptions): string[] {
  const scenarioId = options.scenarioId.trim();
  const needles = new Set(DISALLOWED_BODY_NEEDLES);
  if (scenarioId) {
    needles.add(`agent:qa:${scenarioId}`);
    needles.add(`Agent:qa:${scenarioId}`);
  }
  return [...needles];
}

async function readRequestBody(
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

function decodeRequestBody(
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

function appendCapturedBodyText(
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
  private readonly buffer: Uint8Array;
  private offset = 0;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
  }

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
      const byte = this.buffer[this.offset++];
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

  fixed64(): number {
    const start = this.advance(8, "fixed64");
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + start, 8);
    return view.getFloat64(0, true);
  }

  skip(wire: number) {
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
      value.doubleValue = reader.fixed64();
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

function decodeSpan(message: Uint8Array): OtlpSpan {
  const reader = new ProtoReader(message);
  const span: OtlpSpan = {};
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 4 && wire === 2) {
      span.parentSpanId = reader.bytes();
    } else if (field === 5 && wire === 2) {
      span.name = reader.string();
    } else if (field === 9 && wire === 2) {
      span.attributes ??= [];
      span.attributes.push(decodeKeyValue(reader.bytes()));
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
          name,
          parent: (span.parentSpanId?.length ?? 0) > 0,
          attributes: spanAttributes(span),
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
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 5 && wire === 2) {
      body = normalizeOtlpValue(decodeAnyValue(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  return { body };
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

function startLocalOtlpReceiver(disallowedBodyNeedlesLocal: string[] = []) {
  const capturedRequests: CapturedRequest[] = [];
  const capturedSpans: CapturedSpan[] = [];
  const capturedMetrics: CapturedMetric[] = [];
  const capturedLogRecords: CapturedLogRecord[] = [];
  const capturedBodyText: Partial<Record<OtlpSignal, string[]>> = {};
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
        const compressedBody = await readRequestBody(req);
        body = decodeRequestBody(compressedBody, contentEncoding);
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
        appendCapturedBodyText(
          capturedBodyText,
          signal,
          body,
          undefined,
          disallowedBodyNeedlesLocal,
        );
      } catch (error) {
        appendCapturedBodyText(
          capturedBodyText,
          signal,
          body,
          undefined,
          disallowedBodyNeedlesLocal,
        );
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
      if (spans.length > 0) {
        capturedSpans.push(...spans);
      }
      if (metrics.length > 0) {
        capturedMetrics.push(...metrics);
      }
      if (logRecords.length > 0) {
        capturedLogRecords.push(...logRecords);
      }
      capturedRequests.push({
        path: requestPath,
        signal,
        bytes: body.length,
        contentEncoding,
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
        server.close((err) => (err ? reject(err) : resolve()));
        closeLocalOtlpReceiverConnections(server, sockets);
      });
      await closePromise;
    },
  };
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

async function reserveLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to reserve local port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

async function canConnectToLocalPort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new Socket();
    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, 1000);
    socket.once("connect", () => {
      clearTimeout(timer);
      cleanup();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      cleanup();
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

async function waitForLocalPort(port: number, timeoutMs: number, readFailure: () => string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnectToLocalPort(port)) {
      return;
    }
    const failure = readFailure();
    if (failure) {
      throw new Error(failure);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  throw new Error(`timed out waiting for OpenTelemetry Collector on 127.0.0.1:${port}`);
}

function createBoundedTextAccumulator(maxBytes: number) {
  let tail = Buffer.alloc(0);
  let truncated = false;

  return {
    append(chunk: unknown): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      if (buffer.length >= maxBytes) {
        tail = Buffer.from(buffer.subarray(buffer.length - maxBytes));
        truncated = true;
        return;
      }
      const nextTail = Buffer.concat([tail, buffer]);
      if (nextTail.length > maxBytes) {
        tail = Buffer.from(nextTail.subarray(nextTail.length - maxBytes));
        truncated = true;
        return;
      }
      tail = nextTail;
    },
    byteLength(): number {
      return tail.byteLength;
    },
    text(): string {
      const output = tail.toString("utf8");
      return truncated ? `...\n${output}` : output;
    },
  };
}

async function stopDockerContainer(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn("docker", ["stop", name], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

type StartDockerOtelCollectorDeps = {
  mkdtemp?: typeof mkdtemp;
  platform?: NodeJS.Platform;
  randomUUID?: typeof randomUUID;
  reserveLocalPort?: typeof reserveLocalPort;
  rm?: typeof rm;
  spawn?: typeof spawn;
  stopDockerContainer?: typeof stopDockerContainer;
  tmpdir?: typeof tmpdir;
  waitForLocalPort?: typeof waitForLocalPort;
  writeFile?: typeof writeFile;
};

async function startDockerOtelCollector(
  receiverPort: number,
  deps: StartDockerOtelCollectorDeps = {},
) {
  const reservePort = deps.reserveLocalPort ?? reserveLocalPort;
  const makeTempDir = deps.mkdtemp ?? mkdtemp;
  const writeConfigFile = deps.writeFile ?? writeFile;
  const spawnProcess = deps.spawn ?? spawn;
  const waitForPort = deps.waitForLocalPort ?? waitForLocalPort;
  const stopContainer = deps.stopDockerContainer ?? stopDockerContainer;
  const removePath = deps.rm ?? rm;
  const makeUuid = deps.randomUUID ?? randomUUID;
  const osTmpdir = deps.tmpdir ?? tmpdir;

  const collectorPort = await reservePort();
  const tempDir = await makeTempDir(path.join(osTmpdir(), "openclaw-otel-collector-"));
  const configPath = path.join(tempDir, "collector.yaml");
  const containerName = `openclaw-otel-smoke-${makeUuid()}`;
  const useHostNetwork = (deps.platform ?? process.platform) === "linux";
  const collectorEndpoint = useHostNetwork ? `127.0.0.1:${collectorPort}` : "0.0.0.0:4318";
  const receiverEndpoint = useHostNetwork
    ? `http://127.0.0.1:${receiverPort}`
    : `http://host.docker.internal:${receiverPort}`;
  const config = `receivers:
  otlp:
    protocols:
      http:
        endpoint: ${collectorEndpoint}
exporters:
  otlphttp/openclaw:
    endpoint: ${receiverEndpoint}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/openclaw]
    metrics:
      receivers: [otlp]
      exporters: [otlphttp/openclaw]
    logs:
      receivers: [otlp]
      exporters: [otlphttp/openclaw]
`;
  await writeConfigFile(configPath, config, "utf8");

  const output = createBoundedTextAccumulator(COLLECTOR_OUTPUT_TAIL_BYTES);
  let exitCode: number | null = null;
  const dockerArgs = [
    "run",
    "--rm",
    "--pull=missing",
    "--name",
    containerName,
    ...(useHostNetwork
      ? ["--network", "host"]
      : ["--add-host=host.docker.internal:host-gateway", "-p", `127.0.0.1:${collectorPort}:4318`]),
    "-v",
    `${configPath}:/etc/otelcol/config.yaml:ro`,
    DEFAULT_DOCKER_COLLECTOR_IMAGE,
    "--config=/etc/otelcol/config.yaml",
  ];
  const child = spawnProcess("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => output.append(chunk));
  child.stderr?.on("data", (chunk) => output.append(chunk));
  child.on("error", (err) => {
    output.append(err instanceof Error ? (err.stack ?? err.message) : String(err));
    exitCode = 1;
  });
  child.on("close", (code) => {
    exitCode = code ?? 1;
  });

  try {
    await waitForPort(collectorPort, 60_000, () => {
      if (exitCode === null) {
        return "";
      }
      const collectorOutput = output.text().trim();
      return `OpenTelemetry Collector exited before readiness (code=${exitCode})${collectorOutput ? `:\n${collectorOutput}` : ""}`;
    });
  } catch (error) {
    try {
      await stopContainer(containerName);
    } finally {
      await removePath(tempDir, { force: true, recursive: true });
    }
    throw error;
  }

  return {
    port: collectorPort,
    image: DEFAULT_DOCKER_COLLECTOR_IMAGE,
    network: useHostNetwork ? "host" : "bridge",
    output(): string {
      return output.text().trim();
    },
    async close(): Promise<void> {
      await stopContainer(containerName);
      await removePath(tempDir, { force: true, recursive: true });
    },
  };
}

function openClawEntryArgs(): string[] {
  if (existsSync(path.join(process.cwd(), "scripts", "run-node.mjs"))) {
    return ["scripts/run-node.mjs"];
  }
  return ["openclaw.mjs"];
}

function spawnOpenClaw(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [...openClawEntryArgs(), ...args], {
    detached: process.platform !== "win32",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForChild(
  child: ChildProcess,
  timeoutMs = QA_SUITE_TIMEOUT_MS,
  killGraceMs = QA_SUITE_KILL_GRACE_MS,
): Promise<number> {
  const childExit = new Promise<number>((resolve) => {
    child.once("close", (code) => resolve(code ?? 1));
  });
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
    timeoutHandle.unref();
  });
  const result = await Promise.race([childExit, timeout]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
  if (result !== "timeout") {
    return result;
  }

  const cleanupPids = collectChildProcessTreePids(child);
  terminateChildTree(child, "SIGTERM", cleanupPids);
  if (!(await waitForProcessTreeExit(child, killGraceMs, cleanupPids))) {
    terminateChildTree(child, "SIGKILL", cleanupPids);
    await waitForProcessTreeExit(child, 1000, cleanupPids);
  }
  throw new Error(`openclaw qa suite timed out after ${timeoutMs}ms`);
}

function collectChildProcessTreePids(child: ChildProcess): number[] {
  if (process.platform === "win32" || typeof child.pid !== "number") {
    return [];
  }
  const ps = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (ps.status !== 0) {
    return [child.pid];
  }
  const childrenByParent = new Map<number, number[]>();
  for (const line of ps.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/u);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const siblings = childrenByParent.get(ppid) ?? [];
    siblings.push(pid);
    childrenByParent.set(ppid, siblings);
  }
  const pids = [child.pid];
  for (const parentPid of pids) {
    for (const pid of childrenByParent.get(parentPid) ?? []) {
      pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

function terminateChildTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  pids = collectChildProcessTreePids(child),
  platform = process.platform,
  runTaskkill = spawnSync,
): void {
  if (platform === "win32") {
    if (typeof child.pid === "number") {
      const result = runTaskkill("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      if (result.status === 0) {
        return;
      }
    }
    child.kill(signal);
    return;
  }
  if (pids.length > 0) {
    for (const pid of pids.toReversed()) {
      signalProcessGroupOrPid(pid, signal);
    }
    return;
  }
  child.kill(signal);
}

function signalProcessGroupOrPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function processIdOrGroupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (groupError) {
    if (isErrnoCode(groupError, "EPERM")) {
      return true;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (pidError) {
    return isErrnoCode(pidError, "EPERM");
  }
}

function processTreeIsAlive(
  child: ChildProcess,
  pids = collectChildProcessTreePids(child),
): boolean {
  if (process.platform === "win32") {
    return child.exitCode === null && child.signalCode === null;
  }
  return pids.some((pid) => processIdOrGroupIsAlive(pid));
}

async function waitForProcessTreeExit(
  child: ChildProcess,
  timeoutMs: number,
  pids = collectChildProcessTreePids(child),
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!processTreeIsAlive(child, pids)) {
      return true;
    }
    await delay(50);
  }
  return !processTreeIsAlive(child, pids);
}

function relayParentSignalsToChild(child: ChildProcess): () => void {
  if (process.platform === "win32") {
    return () => {};
  }
  const handlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
  const cleanup = () => {
    for (const { signal, handler } of handlers) {
      process.off(signal, handler);
    }
    handlers.length = 0;
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      terminateChildTree(child, signal);
      cleanup();
      process.kill(process.pid, signal);
    };
    handlers.push({ signal, handler });
    process.once(signal, handler);
  }
  return cleanup;
}

function buildQaEnv(port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OTEL_SDK_DISABLED;
  delete env.OTEL_TRACES_EXPORTER;
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
  env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `http://127.0.0.1:${port}/v1/traces`;
  env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = `http://127.0.0.1:${port}/v1/metrics`;
  env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `http://127.0.0.1:${port}/v1/logs`;
  env.OTEL_SERVICE_NAME = "openclaw-qa-lab-otel-smoke";
  env.OTEL_SEMCONV_STABILITY_OPT_IN = "gen_ai_latest_experimental";
  env.OPENCLAW_QA_SUITE_PROGRESS = env.OPENCLAW_QA_SUITE_PROGRESS ?? "1";
  return env;
}

function buildQaArgs(options: CliOptions): string[] {
  const args = [
    "qa",
    "suite",
    "--provider-mode",
    options.providerMode,
    "--scenario",
    options.scenarioId,
    "--concurrency",
    "1",
    "--output-dir",
    options.outputDir,
    "--fast",
  ];
  if (options.primaryModel) {
    args.push("--model", options.primaryModel);
  }
  if (options.alternateModel) {
    args.push("--alt-model", options.alternateModel);
  }
  return args;
}

function collectAttributeKeys(spans: CapturedSpan[]): Set<string> {
  const keys = new Set<string>();
  for (const span of spans) {
    for (const key of Object.keys(span.attributes)) {
      keys.add(key);
    }
  }
  return keys;
}

function printableContext(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, ".");
}

function findNeedleContexts(body: string, needles: string[]): string[] {
  const contexts: string[] = [];
  for (const needle of needles) {
    const index = body.indexOf(needle);
    if (index < 0) {
      continue;
    }
    const start = Math.max(0, index - 80);
    const end = Math.min(body.length, index + needle.length + 80);
    contexts.push(printableContext(body.slice(start, end)).replaceAll(needle, "[needle]"));
  }
  return contexts;
}

function capturedValueKind(value: string | number | boolean | string[]): string {
  return Array.isArray(value) ? "array" : typeof value;
}

function isLatestGenAiModelCallSpan(span: CapturedSpan): boolean {
  const operationName = span.attributes["gen_ai.operation.name"];
  const modelName = span.attributes["gen_ai.request.model"];
  if (typeof operationName !== "string" || typeof modelName !== "string") {
    return false;
  }
  return (
    span.name === `${operationName} ${modelName}` &&
    typeof span.attributes["openclaw.provider"] === "string" &&
    typeof span.attributes["openclaw.model"] === "string"
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hasRequiredSmokeSignals(receiver: ReturnType<typeof startLocalOtlpReceiver>): boolean {
  const spanNames = new Set(receiver.capturedSpans.map((span) => span.name));
  const metricNames = new Set(receiver.capturedMetrics.map((metric) => metric.name));
  return (
    REQUIRED_SPAN_NAMES.every((name) => spanNames.has(name)) &&
    receiver.capturedSpans.some(isLatestGenAiModelCallSpan) &&
    REQUIRED_METRIC_NAMES.every((name) => metricNames.has(name)) &&
    receiver.capturedLogRecords.length > 0 &&
    ["traces", "metrics", "logs"].every((signal) =>
      receiver.capturedRequests.some((request) => request.signal === signal),
    )
  );
}

async function waitForExpectedTelemetry(
  receiver: ReturnType<typeof startLocalOtlpReceiver>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasRequiredSmokeSignals(receiver)) {
      return;
    }
    await delay(250);
  }
}

function formatBoundedList(values: readonly string[], maxItems: number): string {
  if (values.length === 0) {
    return "(none)";
  }
  const visible = values.slice(0, maxItems);
  const suffix =
    values.length > visible.length ? `, ... (${values.length - visible.length} more)` : "";
  return `${visible.join(", ")}${suffix}`;
}

function assertSmoke(params: {
  childExitCode: number;
  disallowedBodyNeedles: string[];
  spans: CapturedSpan[];
  metrics: CapturedMetric[];
  logRecords: CapturedLogRecord[];
  requests: CapturedRequest[];
  bodyText: Partial<Record<OtlpSignal, string[]>>;
}) {
  const failures: string[] = [];
  const leakContexts: Partial<Record<OtlpSignal, string[]>> = {};
  if (params.childExitCode !== 0) {
    failures.push(`qa suite exited with ${params.childExitCode}`);
  }
  for (const signal of ["traces", "metrics", "logs"] as const) {
    const requests = params.requests.filter((request) => request.signal === signal);
    if (requests.length === 0) {
      failures.push(`no OTLP ${signal} requests were received`);
    }
    const emptyRequests = requests.filter((request) => request.bytes === 0);
    if (emptyRequests.length > 0) {
      failures.push(`empty OTLP ${signal} request received`);
    }
    for (const request of requests.filter((entry) => entry.status < 200 || entry.status >= 300)) {
      failures.push(`OTLP ${signal} request ${request.path} returned status ${request.status}`);
    }
  }
  if (params.spans.length === 0) {
    failures.push("no OTLP trace spans were decoded");
  }
  if (params.metrics.length === 0) {
    failures.push("no OTLP metrics were decoded");
  }
  if (params.logRecords.length === 0) {
    failures.push("no OTLP log records were decoded");
  }

  const spanNames = new Set(params.spans.map((span) => span.name));
  for (const name of REQUIRED_SPAN_NAMES) {
    if (!spanNames.has(name)) {
      failures.push(`missing required span ${name}`);
    }
  }
  const modelSpans = params.spans.filter(isLatestGenAiModelCallSpan);
  if (modelSpans.length === 0) {
    failures.push("missing required GenAI model-call span");
  }
  if (spanNames.has("openclaw.model.call")) {
    failures.push("legacy openclaw.model.call span exported with GenAI semconv opt-in");
  }
  const metricNames = new Set(params.metrics.map((metric) => metric.name));
  for (const name of REQUIRED_METRIC_NAMES) {
    if (!metricNames.has(name)) {
      failures.push(`missing required metric ${name}`);
    }
  }
  const rawLogBodies = params.logRecords
    .map((record) => record.body)
    .filter((body) => body !== "log");
  if (rawLogBodies.length > 0) {
    failures.push(`OTLP log records exported ${rawLogBodies.length} non-placeholder bodies`);
  }

  const attributeKeys = collectAttributeKeys(params.spans);
  const disallowed = [...DISALLOWED_ATTRIBUTE_KEYS].filter((key) => attributeKeys.has(key));
  const contentKeys = [...attributeKeys].filter((key) => key.startsWith("openclaw.content."));
  if (disallowed.length > 0) {
    failures.push(`raw diagnostic id attributes exported: ${disallowed.join(", ")}`);
  }
  if (contentKeys.length > 0) {
    failures.push(`content attributes exported with capture disabled: ${contentKeys.join(", ")}`);
  }
  if (modelSpans.some((span) => Object.hasOwn(span.attributes, "gen_ai.system"))) {
    failures.push("legacy gen_ai.system attribute exported on GenAI model-call span");
  }

  const modelErrorSpans = modelSpans.filter((span) => {
    const serialized = JSON.stringify(span.attributes);
    return (
      Object.hasOwn(span.attributes, "error.type") ||
      Object.hasOwn(span.attributes, "openclaw.errorCategory") ||
      serialized.includes("StreamAbandoned")
    );
  });
  if (modelErrorSpans.length > 0) {
    failures.push("successful QA run exported model-call error attributes");
  }

  const serializedAttributes = JSON.stringify(params.spans.map((span) => span.attributes));
  if (serializedAttributes.includes("StreamAbandoned")) {
    failures.push("StreamAbandoned leaked into OTEL attributes");
  }

  for (const signal of ["traces", "metrics", "logs"] as const) {
    const signalBodies = (params.bodyText[signal] ?? []).join("\n");
    const leakedNeedles = params.disallowedBodyNeedles.filter((needle) =>
      signalBodies.includes(needle),
    );
    if (leakedNeedles.length > 0) {
      leakContexts[signal] = findNeedleContexts(signalBodies, leakedNeedles);
      failures.push(`OTLP ${signal} payload leaked content: ${leakedNeedles.join(", ")}`);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    spanNames: [...spanNames].toSorted(),
    metricNames: [...metricNames].toSorted(),
    logRecordCount: params.logRecords.length,
    modelSpanCount: modelSpans.length,
    modelErrorSpanCount: modelErrorSpans.length,
    disallowedAttributeKeys: disallowed,
    contentAttributeKeys: contentKeys,
    leakContexts,
    signalRequestCounts: {
      traces: params.requests.filter((request) => request.signal === "traces").length,
      metrics: params.requests.filter((request) => request.signal === "metrics").length,
      logs: params.requests.filter((request) => request.signal === "logs").length,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  await mkdir(options.outputDir, { recursive: true });
  const receiver = startLocalOtlpReceiver(disallowedBodyNeedles(options));
  const port = await receiver.listen();
  process.stdout.write(
    `qa-otel-smoke: local OTLP receiver listening on http://127.0.0.1:${port}\n`,
  );

  let collector: Awaited<ReturnType<typeof startDockerOtelCollector>> | undefined;
  let childExitCode = 1;
  try {
    let exportPort = port;
    if (options.collectorMode === "docker") {
      collector = await startDockerOtelCollector(port);
      exportPort = collector.port;
      process.stdout.write(
        `qa-otel-smoke: OpenTelemetry Collector ${collector.image} listening on http://127.0.0.1:${exportPort} (${collector.network} network)\n`,
      );
    }

    const child = spawnOpenClaw(buildQaArgs(options), buildQaEnv(exportPort));
    const cleanupSignalRelay = relayParentSignalsToChild(child);
    child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    try {
      childExitCode = await waitForChild(child);
    } finally {
      cleanupSignalRelay();
    }
    if (childExitCode === 0) {
      await waitForExpectedTelemetry(receiver, 15_000);
    } else {
      await delay(3000);
    }
  } finally {
    try {
      await collector?.close();
    } finally {
      await receiver.close();
    }
  }

  const assertion = assertSmoke({
    childExitCode,
    disallowedBodyNeedles: disallowedBodyNeedles(options),
    spans: receiver.capturedSpans,
    metrics: receiver.capturedMetrics,
    logRecords: receiver.capturedLogRecords,
    requests: receiver.capturedRequests,
    bodyText: receiver.capturedBodyText,
  });
  const summary = {
    passed: assertion.passed,
    failures: assertion.failures,
    outputDir: options.outputDir,
    scenarioId: options.scenarioId,
    providerMode: options.providerMode,
    collectorMode: options.collectorMode,
    requests: receiver.capturedRequests,
    spanCount: receiver.capturedSpans.length,
    metricCount: receiver.capturedMetrics.length,
    logRecordCount: receiver.capturedLogRecords.length,
    spanNames: assertion.spanNames,
    metricNames: assertion.metricNames,
    signalRequestCounts: assertion.signalRequestCounts,
    modelSpanCount: assertion.modelSpanCount,
    modelErrorSpanCount: assertion.modelErrorSpanCount,
    disallowedAttributeKeys: assertion.disallowedAttributeKeys,
    contentAttributeKeys: assertion.contentAttributeKeys,
    leakContexts: assertion.leakContexts,
    collector: collector
      ? {
          image: collector.image,
          network: collector.network,
          output: assertion.passed ? undefined : collector.output(),
        }
      : undefined,
    spans: receiver.capturedSpans.map((span) => ({
      name: span.name,
      parent: span.parent,
      attributeKeys: Object.keys(span.attributes).toSorted(),
    })),
    logBodyKinds: [
      ...new Set(receiver.capturedLogRecords.map((record) => capturedValueKind(record.body))),
    ],
  };
  const summaryPath = path.join(options.outputDir, "otel-smoke-summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`qa-otel-smoke: summary ${summaryPath}\n`);

  if (!assertion.passed) {
    for (const failure of assertion.failures) {
      process.stderr.write(`qa-otel-smoke: ${failure}\n`);
    }
    process.stderr.write(
      `qa-otel-smoke: captured request counts traces=${assertion.signalRequestCounts.traces} ` +
        `metrics=${assertion.signalRequestCounts.metrics} logs=${assertion.signalRequestCounts.logs}\n`,
    );
    process.stderr.write(
      `qa-otel-smoke: captured decoded counts spans=${receiver.capturedSpans.length} ` +
        `metrics=${receiver.capturedMetrics.length} logs=${receiver.capturedLogRecords.length}\n`,
    );
    process.stderr.write(
      `qa-otel-smoke: captured span names: ${formatBoundedList(assertion.spanNames, 40)}\n`,
    );
    process.stderr.write(
      `qa-otel-smoke: captured metric names: ${formatBoundedList(assertion.metricNames, 40)}\n`,
    );
    for (const [signal, contexts] of Object.entries(assertion.leakContexts)) {
      for (const context of contexts ?? []) {
        process.stderr.write(`qa-otel-smoke: ${signal} leak context: ${context}\n`);
      }
    }
    const collectorOutput = collector?.output();
    if (collectorOutput) {
      process.stderr.write(`qa-otel-smoke: collector output:\n${collectorOutput}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `qa-otel-smoke: passed spans=${receiver.capturedSpans.length} ` +
      `metrics=${receiver.capturedMetrics.length} logs=${receiver.capturedLogRecords.length} ` +
      `traces=${assertion.signalRequestCounts.traces} ` +
      `metricRequests=${assertion.signalRequestCounts.metrics} ` +
      `logRequests=${assertion.signalRequestCounts.logs}\n`,
  );
}

export const testing = {
  appendCapturedBodyText,
  assertSmoke,
  createBoundedTextAccumulator,
  decodeRequestBody,
  parseArgs,
  readPositiveIntegerEnv,
  readRequestBody,
  startLocalOtlpReceiver,
  startDockerOtelCollector,
  terminateChildTree,
  waitForChild,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `qa-otel-smoke: ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
