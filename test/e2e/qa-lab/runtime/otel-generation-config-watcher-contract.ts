// Pure contracts shared by the OTEL watcher script and its fast unit coverage.
import path from "node:path";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import type { CapturedSpan } from "./otel-test-support.js";

export type OtelGenerationConfigWatcherOptions = {
  artifactBase: string;
  repoRoot: string;
};

export function parseOtelGenerationConfigWatcherOptions(
  argv: readonly string[],
  repoRoot = process.cwd(),
): OtelGenerationConfigWatcherOptions {
  let artifactBase = path.join(repoRoot, ".artifacts", "qa-e2e", "otel-generation-config-watcher");
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

export function isSpanId(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{16}$/u.test(value);
}

export function inspectOtelParentGraph(
  spans: readonly CapturedSpan[],
  expectedExternalParentSpanId: string,
): {
  externalParentSpanIds: string[];
  valid: boolean;
} {
  const spansById = new Map(
    spans.flatMap((span) => (isSpanId(span.spanId) ? ([[span.spanId, span]] as const) : [])),
  );
  if (spansById.size !== spans.length) {
    return { externalParentSpanIds: [], valid: false };
  }
  const externalParentSpanIds = new Set<string>();
  for (const span of spans) {
    const visited = new Set<string>();
    let current: CapturedSpan | undefined = span;
    while (current) {
      if (!isSpanId(current.parentSpanId)) {
        return { externalParentSpanIds: [...externalParentSpanIds].toSorted(), valid: false };
      }
      if (visited.has(current.parentSpanId)) {
        return { externalParentSpanIds: [...externalParentSpanIds].toSorted(), valid: false };
      }
      visited.add(current.parentSpanId);
      const parent = spansById.get(current.parentSpanId);
      if (!parent) {
        externalParentSpanIds.add(current.parentSpanId);
        if (current.parentSpanId !== expectedExternalParentSpanId) {
          return { externalParentSpanIds: [...externalParentSpanIds].toSorted(), valid: false };
        }
      }
      current = parent;
    }
  }
  return {
    externalParentSpanIds: [...externalParentSpanIds].toSorted(),
    valid:
      externalParentSpanIds.size === 1 && externalParentSpanIds.has(expectedExternalParentSpanId),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function sanitizeOtelWatcherFailure(error: unknown, repoRoot: string): string {
  return formatErrorMessage(error)
    .replace(new RegExp(escapeRegExp(repoRoot), "gu"), "<repo>")
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/giu, "<local-endpoint>")
    .replace(/qa-suite-[0-9a-f-]{20,}/giu, "<gateway-token>")
    .replace(/(?:\/private)?\/var\/folders\/[^\s'"]+/gu, "<temp-path>")
    .replace(/\/tmp\/[^\s'"]+/gu, "<temp-path>")
    .replace(/[a-z]:\\[^\s'"]+/giu, "<absolute-path>")
    .slice(0, 2_000);
}
