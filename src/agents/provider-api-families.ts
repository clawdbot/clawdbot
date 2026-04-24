const GPT_PARALLEL_TOOL_CALLS_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
]);

export function supportsGptParallelToolCallsPayload(api: unknown): boolean {
  return typeof api === "string" && GPT_PARALLEL_TOOL_CALLS_APIS.has(api);
}
