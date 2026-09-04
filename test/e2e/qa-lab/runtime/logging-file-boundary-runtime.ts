import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../../../src/infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../../../src/infra/diagnostic-trace-context.js";
import { getChildLogger, resetLogger, setLoggerOverride } from "../../../../src/logging/logger.js";
import { testApi } from "../../../../src/logging/logger.test-support.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

function artifactBase(argv: readonly string[]): string {
  const index = argv.indexOf("--artifact-base");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) {
    throw new Error("--artifact-base is required");
  }
  return path.resolve(value);
}

function rotatedPath(file: string): string {
  const ext = path.extname(file);
  return `${file.slice(0, -ext.length)}.1${ext}`;
}

export async function runLoggingFileBoundary(outputRoot: string) {
  await mkdir(outputRoot, { recursive: true });
  const logPath = path.join(outputRoot, "openclaw.jsonl");
  const trace = createDiagnosticTraceContext({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    parentSpanId: "1111111111111111",
    traceFlags: "01",
  });
  const diagnostics: Extract<DiagnosticEventPayload, { type: "log.record" }>[] = [];
  resetDiagnosticEventsForTest();
  resetLogger();
  testApi.resetFileLogTransportForTests();
  setLoggerOverride({ level: "info", file: logPath, maxFileBytes: 512 });
  const unsubscribe = onInternalDiagnosticEvent((event) => {
    if (event.type === "log.record") {
      diagnostics.push(event);
    }
  });
  try {
    runWithDiagnosticTraceContext(trace, () => {
      const logger = getChildLogger({ subsystem: "qa-file-boundary" });
      logger.info(`rotation-fill-${"x".repeat(700)}`);
      logger.info({ marker: "correlated" }, "qa-correlated-record");
    });
    await testApi.flushFileLogQueueForTests();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const current = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const archived = (await readFile(rotatedPath(logPath), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const fileRecord = current.find(
      (record: Record<string, unknown>) => record.message === "qa-correlated-record",
    ) as Record<string, unknown> | undefined;
    const diagnostic = diagnostics.find((event) => event.message === "qa-correlated-record");
    if (!fileRecord || !diagnostic) {
      throw new Error("correlated file and diagnostic records were not both emitted");
    }
    const expected = {
      traceId: trace.traceId,
      spanId: trace.spanId,
      parentSpanId: trace.parentSpanId,
      traceFlags: trace.traceFlags,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (fileRecord[key] !== value || diagnostic.trace?.[key as keyof typeof expected] !== value) {
        throw new Error(`trace correlation mismatch for ${key}`);
      }
    }
    return { currentRecords: current.length, archivedRecords: archived.length, trace: expected };
  } finally {
    unsubscribe();
    setLoggerOverride(null);
    resetLogger();
    testApi.resetFileLogTransportForTests();
    resetDiagnosticEventsForTest();
  }
}

async function main() {
  const repoRoot = process.cwd();
  const outputRoot = artifactBase(process.argv.slice(2));
  const startedAt = Date.now();
  const writer = createQaScriptEvidenceWriter({
    artifactBase: outputRoot,
    logFileName: "logging-file-boundary.log",
    primaryModel: "none",
    providerMode: "mock-openai",
    repoRoot,
    target: {
      id: "logging-file-boundary",
      sourcePath: "qa/scenarios/runtime/logging-file-boundary.yaml",
      title: "Logging file boundary",
      codeRefs: [
        "test/e2e/qa-lab/runtime/logging-file-boundary-runtime.ts",
        "src/logging/logger-file-transport.ts",
      ],
    },
  });
  try {
    const result = await runLoggingFileBoundary(outputRoot);
    writer.appendLog(`${JSON.stringify(result)}\n`);
    await writer.write({ durationMs: Date.now() - startedAt, status: "pass" });
  } catch (error) {
    writer.appendLog(`${String(error)}\n`);
    await writer.write({
      details: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
      status: "fail",
    });
    throw error;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  await main();
}
