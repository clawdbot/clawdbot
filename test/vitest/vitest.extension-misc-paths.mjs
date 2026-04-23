export const miscExtensionTestRoots = [
  "extensions/arcee",
  "extensions/brave",
  "extensions/device-pair",
  "extensions/diagnostics-otel",
  "extensions/duckduckgo",
  "extensions/exa",
  "extensions/firecrawl",
  "extensions/fireworks",
  "extensions/kilocode",
  "extensions/litellm",
  "extensions/llm-task",
  "extensions/lobster",
  "extensions/opencode",
  "extensions/opencode-go",
  "extensions/openshell",
  "extensions/perplexity",
  "extensions/phone-control",
  "extensions/searxng",
  "extensions/synthetic",
  "extensions/tavily",
  "extensions/thread-ownership",
  "extensions/vercel-ai-gateway",
  "extensions/webhooks",
];

export function isMiscExtensionRoot(root) {
  return miscExtensionTestRoots.includes(root);
}
