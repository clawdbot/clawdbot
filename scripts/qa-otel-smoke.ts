#!/usr/bin/env -S node --import tsx

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

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
const OTLP_SIGNAL_PATHS = new Map<string, OtlpSignal>([
  ["/v1/traces", "traces"],
  ["/v1/metrics", "metrics"],
  ["/v1/logs", "logs"],
]);
const REQUIRED_SPAN_NAMES = [
  "openclaw.run",
  "openclaw.harness.run",
  "openclaw.model.call",
  "openclaw.context.assembled",
  "openclaw.message.delivery",
] as const;
const REQUIRED_METRIC_NAMES = [
  "openclaw.harness.duration_ms",
] as const;
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
const DISALLOWED_BODY_NEEDLES = [
  "OTEL-QA-SECRET",
  "OTEL-QA-OK",
  "agent:qa:otel-trace-smoke",
];

function usage(): string {
  return `Usage: pnpm qa:otel:smoke [--output-dir <path>] [--provider-mode <mode>] [--scenario <id>] [--model <ref>] [--alt-model <ref>]

Runs a QA-lab scenario with diagnostics-otel enabled against a local OTLP/HTTP
receiver, then asserts the emitted signal shape and privacy contract.
`;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    outputDir: path.join(".artifacts", "qa-e2e", `otel-smoke-${Date.now().toString(36)}`),
    providerMode: "mock-openai",
    scenarioId: DEFAULT_SCENARIO_ID,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const readValue = () => {
      const value = argv[index + 1]?.trim();
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--output-dir") {
      options.outputDir = readValue();
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

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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

  fixed64(): number {
    const end = this.offset + 8;
    if (end > this.buffer.length) {
      throw new Error("truncated protobuf fixed64");
    }
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.offset, 8);
    this.offset = end;
    return view.getFloat64(0, true);
  }

  skip(wire: number) {
    if (wire === 0) {
      this.varint();
    } else if (wire === 1) {
      this.offset += 8;
    } else if (wire === 2) {
      this.bytes();
    } else if (wire === 5) {
      this.offset += 4;
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

function startLocalOtlpReceiver() {
  const capturedRequests: CapturedRequest[] = [];
  const capturedSpans: CapturedSpan[] = [];
  const capturedMetrics: CapturedMetric[] = [];
  const capturedLogRecords: CapturedLogRecord[] = [];
  const capturedBodyText: Partial<Record<OtlpSignal, string[]>> = {};
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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

    const body = await readRequestBody(req);
    const spans = signal === "traces" ? decodeTraceRequest(body) : [];
    const metrics = signal === "metrics" ? decodeMetricRequest(body) : [];
    const logRecords = signal === "logs" ? decodeLogRequest(body) : [];
    if (spans.length > 0) {
      capturedSpans.push(...spans);
    }
    if (metrics.length > 0) {
      capturedMetrics.push(...metrics);
    }
    if (logRecords.length > 0) {
      capturedLogRecords.push(...logRecords);
    }
    capturedBodyText[signal] ??= [];
    capturedBodyText[signal]?.push(body.toString("utf8"));
    capturedRequests.push({
      path: requestPath,
      signal,
      bytes: body.length,
      status: 200,
      spanCount: spans.length,
      metricCount: metrics.length,
      logCount: logRecords.length,
    });
    res.writeHead(200, { "content-type": "application/x-protobuf" });
    res.end();
  });

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
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
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
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForChild(child: ChildProcess): Promise<number> {
  return await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });
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

function assertSmoke(params: {
  childExitCode: number;
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
    failures.push(
      `OTLP log records exported ${rawLogBodies.length} non-placeholder bodies`,
    );
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

  const modelSpans = params.spans.filter((span) => span.name === "openclaw.model.call");
  const modelErrorSpans = modelSpans.filter((span) => {
    const serialized = JSON.stringify(span.attributes);
    return (
      Object.hasOwn(span.attributes, "error.type") ||
      Object.hasOwn(span.attributes, "openclaw.errorCategory") ||
      serialized.includes("StreamAbandoned")
    );
  });
  if (modelSpans.length === 0) {
    failures.push("no openclaw.model.call span was exported");
  }
  if (modelErrorSpans.length > 0) {
    failures.push("successful QA run exported model-call error attributes");
  }

  const serializedAttributes = JSON.stringify(params.spans.map((span) => span.attributes));
  if (serializedAttributes.includes("StreamAbandoned")) {
    failures.push("StreamAbandoned leaked into OTEL attributes");
  }

  for (const signal of ["traces", "metrics", "logs"] as const) {
    const signalBodies = (params.bodyText[signal] ?? []).join("\n");
    const leakedNeedles = DISALLOWED_BODY_NEEDLES.filter((needle) =>
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
  const receiver = startLocalOtlpReceiver();
  const port = await receiver.listen();
  process.stdout.write(
    `qa-otel-smoke: local OTLP receiver listening on http://127.0.0.1:${port}\n`,
  );

  let childExitCode = 1;
  try {
    const child = spawnOpenClaw(buildQaArgs(options), buildQaEnv(port));
    child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    childExitCode = await waitForChild(child);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } finally {
    await receiver.close();
  }

  const assertion = assertSmoke({
    childExitCode,
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
    for (const [signal, contexts] of Object.entries(assertion.leakContexts)) {
      for (const context of contexts ?? []) {
        process.stderr.write(`qa-otel-smoke: ${signal} leak context: ${context}\n`);
      }
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

main().catch((error) => {
  process.stderr.write(
    `qa-otel-smoke: ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
