import type { Model, StreamOptions } from "../types.js";

function isOpencodeEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname.replace(/\.$/, "") === "opencode.ai";
  } catch {
    return false;
  }
}

/** Required conversation identity is independent of optional prompt caching. */
export function resolveOpencodeSessionHeaders(
  model: Pick<Model, "baseUrl" | "headers">,
  options?: Pick<StreamOptions, "sessionId" | "headers">,
): Record<string, string> | undefined {
  if (!options?.sessionId || !isOpencodeEndpoint(model.baseUrl)) {
    return options?.headers;
  }
  if (
    [model.headers, options.headers].some((headers) =>
      Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "x-opencode-session"),
    )
  ) {
    return options.headers;
  }
  return { ...options.headers, "x-opencode-session": options.sessionId };
}
