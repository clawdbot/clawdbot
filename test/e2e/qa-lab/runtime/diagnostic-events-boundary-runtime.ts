// Diagnostic event boundary evidence composes the real model-call producer with SDK subscribers.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
  createDiagnosticTraceContext,
  emitDiagnosticEvent,
  formatDiagnosticTraceparent,
  hasPendingInternalDiagnosticEvent,
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  parseDiagnosticTraceparent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "../../../../src/agents/embedded-agent-runner/run/attempt.model-diagnostic-events.js";
import { onTrustedInternalDiagnosticEvent } from "../../../../src/infra/diagnostic-events.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const RUN_ID = "qa-diagnostic-events-run";
const CALL_ID = "qa-diagnostic-events-call";
const PRIVATE_MODEL_INPUT = "diagnostic-boundary-private-input";
const CALLER_TRACEPARENT = `00-${"a".repeat(32)}-${"b".repeat(16)}-00`;

type RuntimeOptions = {
  artifactBase: string;
  repoRoot: string;
};

type ModelCallEvent = Extract<
  DiagnosticEventPayload,
  { type: "model.call.started" | "model.call.completed" | "model.call.error" }
>;

export type DiagnosticEventsBoundarySummary = {
  deliveredBeforeDrain: number;
  eventTypes: string[];
  failures: string[];
  immutableEventCopies: boolean;
  passed: boolean;
  pendingBeforeDrain: boolean;
  privateEventCount: number;
  propagatedTraceparent?: string;
  publicEventTypes: string[];
  sdkExportsExercised: string[];
  trustedEventCount: number;
};

function parseOptions(argv: string[], repoRoot = process.cwd()): RuntimeOptions {
  let artifactBase = path.join(repoRoot, ".artifacts", "qa-e2e", "diagnostic-events-boundary");
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      const value = argv[++index];
      if (!value) {
        throw new Error("--output-dir requires a value");
      }
      artifactBase = path.resolve(repoRoot, value);
      continue;
    }
    if (arg === "--") {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { artifactBase, repoRoot };
}

function isTargetModelCallEvent(event: DiagnosticEventPayload): event is ModelCallEvent {
  return (
    (event.type === "model.call.started" ||
      event.type === "model.call.completed" ||
      event.type === "model.call.error") &&
    event.callId === CALL_ID
  );
}

function createWriter(options: RuntimeOptions) {
  return createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "diagnostic-events-boundary.log",
    primaryModel: "diagnostic-runtime/model-call-wrapper",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: "diagnostic-events-boundary",
      title: "Diagnostic events composed boundary",
      sourcePath: "test/e2e/qa-lab/runtime/diagnostic-events-boundary-runtime.ts",
      docsRefs: [
        "docs/gateway/opentelemetry.md",
        "docs/logging.md",
        "docs/plugins/sdk-subpaths.md",
      ],
      codeRefs: [
        "src/infra/diagnostic-events.ts",
        "src/infra/diagnostic-trace-context.ts",
        "src/agents/embedded-agent-runner/run/attempt.model-diagnostic-events.ts",
        "src/plugin-sdk/diagnostic-runtime.ts",
      ],
    },
  });
}

async function probeDiagnosticEventsBoundary(): Promise<DiagnosticEventsBoundarySummary> {
  resetDiagnosticEventsForTest();
  const sharedEvents: Array<{ event: ModelCallEvent; metadata: DiagnosticEventMetadata }> = [];
  const trustedEvents: Array<{
    event: ModelCallEvent;
    metadata: DiagnosticEventMetadata;
    privateData: DiagnosticEventPrivateData;
  }> = [];
  const publicEventTypes: string[] = [];
  const stopShared = onInternalDiagnosticEvent((event, metadata) => {
    if (isTargetModelCallEvent(event)) {
      sharedEvents.push({ event, metadata });
    }
  });
  const stopTrusted = onTrustedInternalDiagnosticEvent((event, metadata, privateData) => {
    if (isTargetModelCallEvent(event)) {
      trustedEvents.push({ event, metadata, privateData });
    }
  });
  const stopPublic = onDiagnosticEvent((event) => {
    publicEventTypes.push(event.type);
  });

  let propagatedTraceparent: string | undefined;
  const rootTrace = createDiagnosticTraceContext({
    traceId: "4BF92F3577B34DA6A3CE929D0E0E4736",
    spanId: "00F067AA0BA902B7",
    traceFlags: "01",
  });
  const rootTraceparent = formatDiagnosticTraceparent(rootTrace);
  const parsedRootTraceparent = parseDiagnosticTraceparent(rootTraceparent);
  const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
    ((
      model: Parameters<StreamFn>[0],
      _streamContext: Parameters<StreamFn>[1],
      options: Parameters<StreamFn>[2],
    ) => {
      const header = options?.headers?.traceparent;
      propagatedTraceparent = typeof header === "string" ? header : undefined;
      options?.onPayload?.({ input: PRIVATE_MODEL_INPUT }, model);
      return Promise.resolve({ role: "assistant", content: [] });
    }) as unknown as StreamFn,
    {
      runId: RUN_ID,
      provider: "openai",
      model: "gpt-5.6-luna",
      api: "responses",
      transport: "direct",
      trace: rootTrace,
      contentCapture: {
        inputMessages: true,
        outputMessages: false,
        toolInputs: false,
        toolOutputs: false,
        systemPrompt: false,
        toolDefinitions: false,
        anyModelContent: true,
      },
      nextCallId: () => CALL_ID,
      suppressPluginHooks: true,
    },
  );

  try {
    emitDiagnosticEvent({
      type: "message.queued",
      source: "qa-diagnostic-events-boundary",
      trace: rootTrace,
    });
    await Promise.resolve(
      wrapped(
        { id: "gpt-5.6-luna" } as never,
        {
          messages: [{ role: "user", content: PRIVATE_MODEL_INPUT }],
        } as never,
        {
          headers: { TraceParent: CALLER_TRACEPARENT },
        } as never,
      ),
    );

    const deliveredBeforeDrain = sharedEvents.length;
    const pendingBeforeDrain = hasPendingInternalDiagnosticEvent(
      (event, metadata) =>
        metadata.trusted && event.type === "model.call.completed" && event.callId === CALL_ID,
    );
    await waitForDiagnosticEventsDrained();

    const failures: string[] = [];
    const eventTypes = sharedEvents.map(({ event }) => event.type);
    if (
      !rootTraceparent ||
      parsedRootTraceparent?.traceId !== rootTrace.traceId ||
      parsedRootTraceparent.spanId !== rootTrace.spanId ||
      parsedRootTraceparent.traceFlags !== rootTrace.traceFlags
    ) {
      failures.push("W3C root trace context did not format and parse losslessly");
    }
    if (deliveredBeforeDrain !== 0) {
      failures.push(`model-call events delivered before async drain: ${deliveredBeforeDrain}`);
    }
    if (!pendingBeforeDrain) {
      failures.push("model-call completion was not pending before async drain");
    }
    if (eventTypes.join(",") !== "model.call.started,model.call.completed") {
      failures.push(`unexpected model-call event sequence: ${eventTypes.join(",")}`);
    }
    if (!sharedEvents.every(({ metadata }) => metadata.trusted)) {
      failures.push("model-call events were not dispatcher-trusted");
    }
    if (publicEventTypes.join(",") !== "message.queued") {
      failures.push(
        `public subscription observed unexpected events: ${publicEventTypes.join(",")}`,
      );
    }
    const immutableEventCopies = sharedEvents.every(
      ({ event, metadata }) =>
        Object.isFrozen(event) && Object.isFrozen(event.trace) && Object.isFrozen(metadata),
    );
    if (!immutableEventCopies) {
      failures.push("diagnostic subscribers did not receive immutable event copies");
    }
    const started = sharedEvents.find(({ event }) => event.type === "model.call.started")?.event;
    const modelTrace = started?.trace;
    if (
      !modelTrace?.spanId ||
      modelTrace.traceId !== rootTrace.traceId ||
      modelTrace.parentSpanId !== rootTrace.spanId
    ) {
      failures.push("model-call event did not create a child of the trusted root trace");
    }
    const expectedTraceparent = formatDiagnosticTraceparent(modelTrace);
    if (!expectedTraceparent || propagatedTraceparent !== expectedTraceparent) {
      failures.push("provider traceparent did not match the emitted model-call child trace");
    }
    if (propagatedTraceparent === CALLER_TRACEPARENT) {
      failures.push("caller-supplied traceparent was not replaced by trusted runtime context");
    }
    const parsedProviderTraceparent = parseDiagnosticTraceparent(propagatedTraceparent);
    if (
      !modelTrace?.spanId ||
      !parsedProviderTraceparent ||
      parsedProviderTraceparent.traceId !== modelTrace.traceId ||
      parsedProviderTraceparent.spanId !== modelTrace.spanId ||
      parsedProviderTraceparent.traceFlags !== modelTrace.traceFlags
    ) {
      failures.push("provider traceparent did not parse back to the model-call trace");
    }
    if (trustedEvents.length !== 2) {
      failures.push(`trusted subscription observed ${trustedEvents.length} model-call events`);
    }
    if (
      !trustedEvents.every(
        ({ metadata, privateData }) =>
          metadata.trusted &&
          Object.isFrozen(privateData) &&
          JSON.stringify(privateData).includes(PRIVATE_MODEL_INPUT),
      )
    ) {
      failures.push("trusted subscription did not receive immutable private model content");
    }
    if (JSON.stringify(sharedEvents).includes(PRIVATE_MODEL_INPUT)) {
      failures.push("private model content leaked into shared diagnostic event payloads");
    }

    return {
      deliveredBeforeDrain,
      eventTypes,
      failures,
      immutableEventCopies,
      passed: failures.length === 0,
      pendingBeforeDrain,
      privateEventCount: trustedEvents.length,
      propagatedTraceparent,
      publicEventTypes,
      sdkExportsExercised: [
        "createDiagnosticTraceContext",
        "emitDiagnosticEvent",
        "formatDiagnosticTraceparent",
        "hasPendingInternalDiagnosticEvent",
        "onDiagnosticEvent",
        "onInternalDiagnosticEvent",
        "parseDiagnosticTraceparent",
        "resetDiagnosticEventsForTest",
        "waitForDiagnosticEventsDrained",
      ],
      trustedEventCount: sharedEvents.filter(({ metadata }) => metadata.trusted).length,
    };
  } finally {
    stopPublic();
    stopShared();
    stopTrusted();
    resetDiagnosticEventsForTest();
  }
}

export async function runDiagnosticEventsBoundaryRuntime(options: RuntimeOptions) {
  const writer = createWriter(options);
  const startedAt = Date.now();
  const summary = await probeDiagnosticEventsBoundary();
  const summaryPath = path.join(options.artifactBase, "diagnostic-events-boundary-summary.json");
  await fs.mkdir(options.artifactBase, { recursive: true });
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writer.appendLog(
    `diagnostic-events-boundary: ${summary.passed ? "passed" : "failed"} ` +
      `events=${summary.eventTypes.join(",")} traceparent=${summary.propagatedTraceparent ?? "missing"}\n`,
  );
  const evidence = await writer.write({
    artifacts: [{ kind: "summary", filePath: summaryPath }],
    details: summary.passed
      ? `trusted model-call events=${summary.trustedEventCount}`
      : summary.failures.join("\n"),
    durationMs: Math.max(1, Date.now() - startedAt),
    status: summary.passed ? "pass" : "fail",
  });
  return { evidence, summary };
}

async function main() {
  const result = await runDiagnosticEventsBoundaryRuntime(parseOptions(process.argv.slice(2)));
  process.stdout.write(
    `diagnostic-events-boundary: ${result.summary.passed ? "passed" : "failed"}\n`,
  );
  if (!result.summary.passed) {
    process.exitCode = 1;
  }
}

export const testing = { parseOptions, probeDiagnosticEventsBoundary };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`diagnostic-events-boundary: ${formatErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
