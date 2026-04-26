#!/usr/bin/env -S node --import tsx

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
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

type OtlpTraceRequest = {
  resourceSpans?: OtlpResourceSpans[];
};

type OtlpRoot = {
  opentelemetry: {
    proto: {
      collector: {
        trace: {
          v1: {
            ExportTraceServiceRequest: {
              decode(input: Uint8Array): OtlpTraceRequest;
            };
          };
        };
      };
    };
  };
};

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
  bytes: number;
  status: number;
  spanCount: number;
};

type CapturedSpan = {
  name: string;
  parent: boolean;
  attributes: Record<string, string | number | boolean | string[]>;
};

const DEFAULT_SCENARIO_ID = "otel-trace-smoke";
const REQUIRED_SPAN_NAMES = [
  "openclaw.run",
  "openclaw.harness.run",
  "openclaw.model.call",
  "openclaw.context.assembled",
  "openclaw.message.delivery",
] as const;
const DISALLOWED_ATTRIBUTE_KEYS = new Set([
  "openclaw.runId",
  "openclaw.sessionKey",
  "openclaw.sessionId",
  "openclaw.callId",
  "openclaw.toolCallId",
]);

const require = createRequire(import.meta.url);
const otlpRoot = require("@opentelemetry/otlp-transformer/build/src/generated/root.js") as OtlpRoot;
const traceRequestDecoder =
  otlpRoot.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;

function usage(): string {
  return `Usage: pnpm qa:otel:smoke [--output-dir <path>] [--provider-mode <mode>] [--scenario <id>] [--model <ref>] [--alt-model <ref>]

Runs a QA-lab scenario with diagnostics-otel enabled against a local OTLP/HTTP
trace receiver, then asserts the emitted span shape and privacy contract.
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

function decodeTraceRequest(body: Buffer): CapturedSpan[] {
  const decoded = traceRequestDecoder.decode(body);
  const spans: CapturedSpan[] = [];
  for (const resourceSpans of decoded.resourceSpans ?? []) {
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
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

function startLocalOtlpTraceReceiver() {
  const capturedRequests: CapturedRequest[] = [];
  const capturedSpans: CapturedSpan[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || req.url !== "/v1/traces") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    const body = await readRequestBody(req);
    const spans = decodeTraceRequest(body);
    capturedSpans.push(...spans);
    capturedRequests.push({
      path: req.url,
      bytes: body.length,
      status: 200,
      spanCount: spans.length,
    });
    res.writeHead(200, { "content-type": "application/x-protobuf" });
    res.end();
  });

  return {
    capturedRequests,
    capturedSpans,
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

function spawnPnpm(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const npmExecPath = process.env.npm_execpath?.trim();
  if (npmExecPath) {
    return spawn(process.execPath, [npmExecPath, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
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
  delete env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  delete env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `http://127.0.0.1:${port}/v1/traces`;
  env.OTEL_SERVICE_NAME = "openclaw-qa-lab-otel-smoke";
  env.OTEL_SEMCONV_STABILITY_OPT_IN = "gen_ai_latest_experimental";
  env.OPENCLAW_QA_SUITE_PROGRESS = env.OPENCLAW_QA_SUITE_PROGRESS ?? "1";
  return env;
}

function buildQaArgs(options: CliOptions): string[] {
  const args = [
    "openclaw",
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

function assertSmoke(params: {
  childExitCode: number;
  spans: CapturedSpan[];
  requests: CapturedRequest[];
}) {
  const failures: string[] = [];
  if (params.childExitCode !== 0) {
    failures.push(`qa suite exited with ${params.childExitCode}`);
  }
  if (params.requests.length === 0) {
    failures.push("no OTLP trace requests were received");
  }
  if (params.spans.length === 0) {
    failures.push("no OTLP trace spans were decoded");
  }

  const spanNames = new Set(params.spans.map((span) => span.name));
  for (const name of REQUIRED_SPAN_NAMES) {
    if (!spanNames.has(name)) {
      failures.push(`missing required span ${name}`);
    }
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

  return {
    passed: failures.length === 0,
    failures,
    spanNames: [...spanNames].toSorted(),
    modelSpanCount: modelSpans.length,
    modelErrorSpanCount: modelErrorSpans.length,
    disallowedAttributeKeys: disallowed,
    contentAttributeKeys: contentKeys,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  await mkdir(options.outputDir, { recursive: true });
  const receiver = startLocalOtlpTraceReceiver();
  const port = await receiver.listen();
  process.stdout.write(
    `qa-otel-smoke: local OTLP trace receiver listening on http://127.0.0.1:${port}/v1/traces\n`,
  );

  let childExitCode = 1;
  try {
    const child = spawnPnpm(buildQaArgs(options), buildQaEnv(port));
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
    requests: receiver.capturedRequests,
  });
  const summary = {
    passed: assertion.passed,
    failures: assertion.failures,
    outputDir: options.outputDir,
    scenarioId: options.scenarioId,
    providerMode: options.providerMode,
    requests: receiver.capturedRequests,
    spanCount: receiver.capturedSpans.length,
    spanNames: assertion.spanNames,
    modelSpanCount: assertion.modelSpanCount,
    modelErrorSpanCount: assertion.modelErrorSpanCount,
    disallowedAttributeKeys: assertion.disallowedAttributeKeys,
    contentAttributeKeys: assertion.contentAttributeKeys,
    spans: receiver.capturedSpans.map((span) => ({
      name: span.name,
      parent: span.parent,
      attributeKeys: Object.keys(span.attributes).toSorted(),
    })),
  };
  const summaryPath = path.join(options.outputDir, "otel-smoke-summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`qa-otel-smoke: summary ${summaryPath}\n`);

  if (!assertion.passed) {
    for (const failure of assertion.failures) {
      process.stderr.write(`qa-otel-smoke: ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `qa-otel-smoke: passed spans=${receiver.capturedSpans.length} requests=${receiver.capturedRequests.length}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `qa-otel-smoke: ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
