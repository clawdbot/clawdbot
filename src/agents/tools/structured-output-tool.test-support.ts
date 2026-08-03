import type { SwarmStructuredOutputState } from "../subagent-registry.types.js";
import "./structured-output-tool.js";

type StructuredOutputToolTestApi = {
  testing: {
    readSwarmStructuredOutput(runId: string): SwarmStructuredOutputState | undefined;
    reset(): void;
  };
};

function getTestApi(): StructuredOutputToolTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.structuredOutputToolTestApi")
  ] as StructuredOutputToolTestApi;
}

export const testing = getTestApi().testing;
