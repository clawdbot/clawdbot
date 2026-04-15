import type { OpenClawConfig } from "../api.js";

const DEFAULT_GATEWAY_PORT = 18789;
type ViewerBaseUrlFieldName = "baseUrl" | "viewerBaseUrl";

export function buildViewerUrl(params: {
  config: OpenClawConfig;
  viewerPath: string;
  baseUrl?: string;
}): string {
  const baseUrl = params.baseUrl?.trim() || resolveGatewayBaseUrl(params.config);
  const normalizedBase = normalizeViewerBaseUrl(baseUrl);
  const viewerPath = params.viewerPath.startsWith("/")
    ? params.viewerPath
    : `/${params.viewerPath}`;
  const parsedBase = new URL(normalizedBase);
  const basePath = parsedBase.pathname === "/" ? "" : parsedBase.pathname.replace(/\/+$/, "");
  parsedBase.pathname = `${basePath}${viewerPath}`;
  parsedBase.search = "";
  parsedBase.hash = "";
  return parsedBase.toString();
}

export function normalizeViewerBaseUrl(
  raw: string,
  fieldName: ViewerBaseUrlFieldName = "baseUrl",
): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid ${fieldName}: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${fieldName} must use http or https: ${raw}`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${fieldName} must not include query/hash: ${raw}`);
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  const withoutTrailingSlash = parsed.toString().replace(/\/+$/, "");
  return withoutTrailingSlash;
}

function resolveGatewayBaseUrl(config: OpenClawConfig): string {
  const scheme = config.gateway?.tls?.enabled ? "https" : "http";
  const port =
    typeof config.gateway?.port === "number" ? config.gateway.port : DEFAULT_GATEWAY_PORT;
  const customHost = config.gateway?.customBindHost?.trim();

  if (config.gateway?.bind === "custom" && customHost) {
    return `${scheme}://${customHost}:${port}`;
  }

  // Viewer links are used by local canvas/clients; default to loopback to avoid
  // container/bridge interfaces that are often unreachable from the caller.
  return `${scheme}://127.0.0.1:${port}`;
}
