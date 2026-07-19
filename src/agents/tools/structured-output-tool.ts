import { Type } from "typebox";
import { validateJsonSchemaValue } from "../../plugins/schema-validator.js";
import type { JsonSchemaObject } from "../../shared/json-schema.types.js";
import type { SwarmStructuredOutputState } from "../subagent-registry.types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

const states = new Map<string, SwarmStructuredOutputState>();

function formatSchemaError(errors: Array<{ text: string }>): string {
  return errors
    .slice(0, 3)
    .map((error) => error.text)
    .join("; ");
}

function readSwarmStructuredOutput(runId: string): SwarmStructuredOutputState | undefined {
  const state = states.get(runId);
  return state ? structuredClone(state) : undefined;
}

export function consumeSwarmStructuredOutput(
  runId: string,
): SwarmStructuredOutputState | undefined {
  const state = readSwarmStructuredOutput(runId);
  states.delete(runId);
  return state;
}

export function createStructuredOutputTool(params: {
  runId: string;
  schema: Record<string, unknown>;
  initialState?: SwarmStructuredOutputState;
  onStateChange?: (state: SwarmStructuredOutputState) => void;
}): AnyAgentTool {
  const requestedSchema = JSON.stringify(params.schema);
  if (params.initialState && !states.has(params.runId)) {
    states.set(params.runId, structuredClone(params.initialState));
  }
  const commitState = (next: SwarmStructuredOutputState) => {
    const previous = states.get(params.runId);
    states.set(params.runId, next);
    try {
      params.onStateChange?.(structuredClone(next));
    } catch (error) {
      if (previous) {
        states.set(params.runId, previous);
      } else {
        states.delete(params.runId);
      }
      throw new ToolInputError(
        `Failed to persist structured_output: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  return {
    label: "Structured Output",
    name: "structured_output",
    displaySummary: "Record the collector result.",
    description: `Call exactly once as {"result": ...}, where result matches this JSON Schema: ${requestedSchema}`,
    // Runtime argument validation must reach execute so invalid attempts consume
    // the durable one-retry budget. The requested schema remains model-visible above.
    parameters: Type.Object({ result: Type.Unknown() }, { additionalProperties: false }),
    execute: async (_toolCallId, args) => {
      const prior = states.get(params.runId);
      if (prior?.structured !== undefined) {
        throw new ToolInputError("structured_output already recorded for this run");
      }
      if (prior && prior.invalidAttempts >= 2) {
        return jsonResult({ status: "rejected", schemaError: prior.schemaError });
      }
      let validation: ReturnType<typeof validateJsonSchemaValue>;
      try {
        validation = validateJsonSchemaValue({
          schema: params.schema as JsonSchemaObject,
          cacheKey: `swarm-structured-output:${params.runId}`,
          value: (args as { result: unknown }).result,
        });
      } catch (error) {
        throw new ToolInputError(
          `Invalid sessions_spawn outputSchema: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (validation.ok) {
        commitState({ structured: validation.value, invalidAttempts: 0 });
        return jsonResult({ status: "recorded" });
      }
      const invalidAttempts = (prior?.invalidAttempts ?? 0) + 1;
      const schemaError = formatSchemaError(validation.errors);
      commitState({ structured: undefined, invalidAttempts, schemaError });
      if (invalidAttempts === 1) {
        throw new ToolInputError(
          `structured_output validation failed: ${schemaError}. Retry once with a corrected final result.`,
        );
      }
      return jsonResult({ status: "rejected", schemaError });
    },
  };
}

const testing = {
  readSwarmStructuredOutput,
  reset() {
    states.clear();
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.structuredOutputToolTestApi")] =
    { testing };
}
