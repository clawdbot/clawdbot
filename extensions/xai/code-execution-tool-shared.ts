// Xai plugin module implements code execution tool shared behavior.
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";

export function buildMissingCodeExecutionApiKeyPayload() {
  return {
    error: "missing_xai_api_key",
    message:
      "code_execution needs xAI credentials. Run `openclaw onboard --auth-choice xai-oauth` to sign in with Grok, run `openclaw onboard --auth-choice xai-api-key`, set `XAI_API_KEY` in the Gateway environment, or configure `plugins.entries.xai.config.webSearch.apiKey`.",
    docs: "https://docs.openclaw.ai/tools/code-execution",
  };
}

export function createCodeExecutionToolDefinition(
  execute: (toolCallId: string, args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>,
) {
  return {
    label: "Code Execution",
    name: "code_execution",
    description:
      "Run sandboxed Python analysis with xAI. Use for calculations, tabulation, summaries, and chart-style analysis without local machine access.",
    parameters: Type.Object({
      task: Type.String({
        description:
          "The full analysis task for xAI's remote Python sandbox. Include any data to analyze directly in the task.",
      }),
    }),
    execute,
  };
}
