// Memory Host SDK module implements Azure OpenAI-compatible embedding request
// normalization: api-version must travel as a URL query parameter, not a header.

// Azure OpenAI and Azure AI Foundry reject requests whose api-version is only
// supplied as an HTTP header. The chat completions transport performs the same
// header-to-query migration (see packages/ai isAzureOpenAICompatibleHost and
// buildOpenAICompletionsClientConfig). Embedding fetches keep configured
// headers untouched for cache identity and instead normalize the outgoing
// request: recognized Azure hosts move a non-empty api-version header into the
// URL query (an existing non-empty URL value wins) and drop the header.

/** Detect Azure OpenAI-compatible embedding hosts. */
function isAzureOpenAICompatibleHost(hostname: string): boolean {
  return (
    hostname.endsWith(".openai.azure.com") ||
    hostname.endsWith(".services.ai.azure.com") ||
    hostname.endsWith(".cognitiveservices.azure.com")
  );
}

/**
 * Normalize an embedding request target for Azure OpenAI-compatible hosts.
 *
 * Returns the same {@link url} and {@link headers} when the host is not Azure
 * or no api-version header is present. For recognized Azure hosts a
 * case-insensitive api-version header with a non-empty value is migrated into
 * the URL query when the URL has no non-empty api-version value, and the header
 * is removed. An existing non-empty URL api-version always wins, mirroring the
 * chat completions transport.
 */
export function resolveAzureApiVersionRequestTarget(params: {
  url: string;
  headers: Record<string, string>;
}): { url: string; headers: Record<string, string> } {
  const { url, headers } = params;
  let hostname: string | undefined;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return params;
  }
  if (!isAzureOpenAICompatibleHost(hostname)) {
    return params;
  }
  const headerKey = Object.keys(headers).find((key) => key.toLowerCase() === "api-version");
  if (!headerKey) {
    return params;
  }
  const apiVersion = headers[headerKey]?.trim();
  // Remove the header regardless of its value; only a non-empty value is
  // eligible for promotion into the URL query.
  const nextHeaders = { ...headers };
  delete nextHeaders[headerKey];
  if (!apiVersion) {
    return { url, headers: nextHeaders };
  }
  const parsed = new URL(url);
  const existing = parsed.searchParams.get("api-version");
  if (existing === null || existing.trim() === "") {
    parsed.searchParams.set("api-version", apiVersion);
  }
  return { url: parsed.toString(), headers: nextHeaders };
}
