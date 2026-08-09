import type {
  EmbeddedRunAttemptParams,
  SwarmStructuredOutputState,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";

type NativeStructuredOutputAttempt = Pick<
  EmbeddedRunAttemptParams,
  "onSwarmStructuredOutputState" | "runId" | "swarmCollector" | "swarmOutputSchema"
>;

export function isCodexNativeStructuredOutputAttempt(
  params: NativeStructuredOutputAttempt,
): boolean {
  return (
    params.swarmCollector === true &&
    params.swarmOutputSchema !== undefined &&
    typeof params.onSwarmStructuredOutputState === "function"
  );
}

function formatSchemaError(errors: Array<{ text: string }>): string {
  return errors
    .slice(0, 3)
    .map((error) => error.text)
    .join("; ");
}

async function persistRejectedState(
  persist: NonNullable<NativeStructuredOutputAttempt["onSwarmStructuredOutputState"]>,
  schemaError: string,
): Promise<never> {
  const state: SwarmStructuredOutputState = {
    structured: undefined,
    invalidAttempts: 1,
    schemaError,
  };
  await persist(state);
  throw new Error(schemaError);
}

/** Validates and durably captures Codex's schema-constrained final assistant message. */
export async function captureCodexNativeStructuredOutput(params: {
  attempt: NativeStructuredOutputAttempt;
  terminalAssistantText: string;
}): Promise<void> {
  const { attempt } = params;
  const persist = attempt.onSwarmStructuredOutputState;
  if (!isCodexNativeStructuredOutputAttempt(attempt) || !persist) {
    return;
  }
  const terminalAssistantText = params.terminalAssistantText.trim();
  if (!terminalAssistantText) {
    return persistRejectedState(persist, "Codex native collector result was missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(terminalAssistantText);
  } catch {
    return persistRejectedState(persist, "Codex native collector result was not valid JSON");
  }
  const validation = validateJsonSchemaValue({
    schema: attempt.swarmOutputSchema as JsonSchemaObject,
    cacheKey: `codex-native-swarm-output:${attempt.runId}`,
    value: parsed,
  });
  if (!validation.ok) {
    return persistRejectedState(
      persist,
      `Codex native collector result failed schema validation: ${formatSchemaError(validation.errors)}`,
    );
  }
  await persist({
    structured: validation.value,
    invalidAttempts: 0,
  });
}
