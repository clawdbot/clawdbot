import type { FailoverClassification, FailoverReason, FailoverSignal } from "./signal.js";

export type FailoverClassificationCorpusRow = {
  id: string;
  source: string;
  signal: FailoverSignal;
  expected: FailoverClassification | null;
};

export const reason = (value: FailoverReason): FailoverClassification => ({
  kind: "reason",
  reason: value,
});
export const contextOverflow: FailoverClassification = { kind: "context_overflow" };

type LegacyFailoverCorpusCase = readonly [
  caseNumber: number,
  matcher: string | readonly [source: string, matcher: string],
  message: string,
  expected: FailoverReason | "context_overflow" | null,
  provider?: string,
];

export function legacyFailoverCorpusRows(
  prefix: string,
  source: string,
  rows: readonly LegacyFailoverCorpusCase[],
): FailoverClassificationCorpusRow[] {
  return rows.map(([caseNumber, matcher, message, expected, provider]) => ({
    id: `${prefix}-${String(caseNumber).padStart(3, "0")}`,
    source: typeof matcher === "string" ? `${source}#${matcher}` : `${matcher[0]}#${matcher[1]}`,
    signal: provider ? { provider, message } : { message },
    expected:
      expected === null
        ? null
        : expected === "context_overflow"
          ? contextOverflow
          : reason(expected),
  }));
}

export function failoverSignalRows(
  source: string,
  expected: FailoverClassification | null,
  rows: readonly (readonly [id: string, signal: FailoverSignal])[],
): FailoverClassificationCorpusRow[] {
  return rows.map(([id, signal]) => ({ id, source, signal, expected }));
}

export function messageRows(
  source: string,
  expected: FailoverClassification | null,
  rows: readonly { id: string; message: string; provider?: string; status?: number }[],
): FailoverClassificationCorpusRow[] {
  return rows.map(({ id, message, provider, status }) => ({
    id,
    source,
    signal: { message, ...(provider ? { provider } : {}), ...(status ? { status } : {}) },
    expected,
  }));
}

export const billingSource = "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts";
export const matchesSource = "src/agents/embedded-agent-helpers/failover-matches.test.ts";
export const patternsSource = "src/agents/embedded-agent-helpers/provider-error-patterns.test.ts";
export const errorsSource = "src/agents/embedded-agent-helpers/errors.test.ts";
export const structuredSource =
  "src/agents/embedded-agent-helpers/errors-provider-structured-signals.test.ts";
export const httpSource = "src/agents/provider-http-errors.test.ts";
export const openRouterSource = "src/agents/openrouter-error-classification.integration.test.ts";
export const retrySource = "src/llm/utils/retry.test.ts";
