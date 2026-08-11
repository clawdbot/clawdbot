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
