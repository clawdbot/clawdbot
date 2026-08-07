import type {
  AgentHarnessSideQuestionParams,
  EmbeddedRunAttemptParams,
} from "./agent-harness-runtime.js";

type OpenClawCodingToolsOptions = NonNullable<
  Parameters<typeof import("./agent-harness.js").createOpenClawCodingTools>[0]
>;

/**
 * Build tools for the exact host-admitted attempt without exposing its private
 * execution attribution to plugin code.
 */
export async function createOpenClawCodingToolsForAgentHarness(
  attempt: EmbeddedRunAttemptParams,
  options?: OpenClawCodingToolsOptions,
): Promise<
  ReturnType<
    typeof import("../agents/agent-tools-internal.js").createOpenClawCodingToolsForAgentHarness
  >
> {
  const { createOpenClawCodingToolsForAgentHarness: createCoreOpenClawCodingToolsForAgentHarness } =
    await import("../agents/agent-tools-internal.js");
  return createCoreOpenClawCodingToolsForAgentHarness(attempt, options);
}

/**
 * Build tools for the exact host-admitted side-question request without
 * exposing its private execution attribution to plugin code.
 */
export async function createOpenClawCodingToolsForAgentHarnessSideQuestion(
  params: AgentHarnessSideQuestionParams,
  options?: OpenClawCodingToolsOptions,
): Promise<
  ReturnType<
    typeof import("../agents/agent-tools-internal.js").createOpenClawCodingToolsForAgentHarnessSideQuestion
  >
> {
  const {
    createOpenClawCodingToolsForAgentHarnessSideQuestion:
      createCoreOpenClawCodingToolsForAgentHarnessSideQuestion,
  } = await import("../agents/agent-tools-internal.js");
  return createCoreOpenClawCodingToolsForAgentHarnessSideQuestion(params, options);
}
