/**
 * Small API-family predicates used when constructing provider payloads. The
 * sets here encode transport-level compatibility, not provider identity.
 */
const GPT_PARALLEL_TOOL_CALLS_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "openai-chatgpt-responses",
  "azure-openai-responses",
]);

/** True when a provider API accepts GPT parallel-tool-call payload settings. */
export function supportsGptParallelToolCallsPayload(api: unknown): boolean {
  return typeof api === "string" && GPT_PARALLEL_TOOL_CALLS_APIS.has(api);
}
