export type McpAppCsp = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

export const MCP_APP_SANDBOX_PATH = "/mcp-app-sandbox";
export const MCP_APP_SANDBOX_PORT_OFFSET = 1;
const MCP_APP_SANDBOX_CSP_QUERY = "csp";
const MCP_APP_SANDBOX_CSP_MAX_JSON_BYTES = 5 * 1024;
const MCP_APP_SANDBOX_CSP_MAX_HEADER_BYTES = 6 * 1024;
const MCP_APP_SANDBOX_CSP_MAX_ENCODED_BYTES =
  Math.ceil(MCP_APP_SANDBOX_CSP_MAX_JSON_BYTES / 3) * 4 + 4;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeDomains(
  value: unknown,
  options?: { allowWebSocket?: boolean },
): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const protocols = options?.allowWebSocket ? "(?:https?|wss?)" : "https?";
  const pattern = new RegExp(`^${protocols}:\\/\\/(?:\\*\\.)?[A-Za-z0-9.-]+(?::[0-9]+)?$`);
  const entries = value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.length <= 2048 && pattern.test(entry),
  );
  return entries.length > 0 ? entries : undefined;
}

export function normalizeMcpAppCsp(value: unknown): McpAppCsp | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const csp: McpAppCsp = {
    connectDomains: normalizeDomains(record.connectDomains, { allowWebSocket: true }),
    resourceDomains: normalizeDomains(record.resourceDomains),
    frameDomains: normalizeDomains(record.frameDomains),
    baseUriDomains: normalizeDomains(record.baseUriDomains),
  };
  if (!Object.values(csp).some(Boolean)) {
    return undefined;
  }
  const jsonBytes = Buffer.byteLength(JSON.stringify(csp), "utf8");
  const headerBytes = Buffer.byteLength(buildMcpAppContentSecurityPolicy(csp), "utf8");
  if (
    jsonBytes > MCP_APP_SANDBOX_CSP_MAX_JSON_BYTES ||
    headerBytes > MCP_APP_SANDBOX_CSP_MAX_HEADER_BYTES
  ) {
    throw new Error("MCP App CSP metadata exceeds safe HTTP limits");
  }
  return csp;
}

function encodeCsp(csp?: McpAppCsp): string | undefined {
  const normalized = normalizeMcpAppCsp(csp);
  if (!normalized) {
    return undefined;
  }
  return Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
}

export function buildMcpAppSandboxPath(csp?: McpAppCsp): string {
  const encoded = encodeCsp(csp);
  return encoded
    ? `${MCP_APP_SANDBOX_PATH}?${MCP_APP_SANDBOX_CSP_QUERY}=${encoded}`
    : MCP_APP_SANDBOX_PATH;
}

export function resolveMcpAppSandboxPort(gatewayPort: number, configuredPort?: number): number {
  const sandboxPort = configuredPort ?? gatewayPort + MCP_APP_SANDBOX_PORT_OFFSET;
  if (
    !Number.isInteger(gatewayPort) ||
    gatewayPort < 1 ||
    gatewayPort > 65535 ||
    !Number.isInteger(sandboxPort) ||
    sandboxPort < 1 ||
    sandboxPort > 65535 ||
    sandboxPort === gatewayPort
  ) {
    throw new Error("MCP Apps require distinct valid Gateway and sandbox ports");
  }
  return sandboxPort;
}

export function decodeMcpAppSandboxCsp(value: string | null): McpAppCsp | undefined {
  if (!value) {
    return undefined;
  }
  if (value.length > MCP_APP_SANDBOX_CSP_MAX_ENCODED_BYTES) {
    throw new Error("MCP App CSP metadata is too large");
  }
  const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  return normalizeMcpAppCsp(decoded);
}

/** Trusted outer document. The untrusted app HTML is written only into its inner iframe. */
export function buildMcpAppSandboxProxyHtml(): string {
  return `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>MCP App sandbox</title>
<style>html,body{height:100%;margin:0;background:transparent}iframe{display:block;width:100%;height:100%;border:0;background:transparent}</style>
<body>
<script>
(() => {
  if (window.self === window.top) throw new Error("invalid MCP App sandbox host");
  let hostOrigin = null;
  try { void window.top.document; throw new Error("MCP App sandbox isolation failed"); } catch (error) {
    if (error instanceof Error && error.message === "MCP App sandbox isolation failed") throw error;
  }
  const inner = document.createElement("iframe");
  inner.setAttribute("sandbox", "allow-scripts allow-forms");
  document.body.appendChild(inner);
  window.addEventListener("message", (event) => {
    if (event.source === window.parent) {
      if (hostOrigin === null) hostOrigin = event.origin;
      if (event.origin !== hostOrigin) return;
      if (event.data?.method === "ui/notifications/sandbox-resource-ready") {
        const params = event.data.params ?? {};
        if (typeof params.html === "string") {
          inner.srcdoc = params.html;
        }
        return;
      }
      if (typeof event.data?.method === "string" && event.data.method.startsWith("ui/notifications/sandbox-")) return;
      inner.contentWindow?.postMessage(event.data, "*");
      return;
    }
    if (event.source === inner.contentWindow && hostOrigin !== null) {
      if (typeof event.data?.method === "string" && event.data.method.startsWith("ui/notifications/sandbox-")) return;
      window.parent.postMessage(event.data, hostOrigin);
    }
  });
  window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} }, "*");
})();
</script>
</body>`;
}

/** HTTP response policy for the isolated proxy and its inner about:blank app. */
export function buildMcpAppContentSecurityPolicy(csp?: McpAppCsp): string {
  const resources = csp?.resourceDomains ?? [];
  const connections = csp?.connectDomains ?? [];
  const frames = csp?.frameDomains ?? [];
  const bases = csp?.baseUriDomains ?? [];
  const sources = (values: string[]) => (values.length > 0 ? values.join(" ") : "'none'");
  const directives = [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${resources.join(" ")}`.trim(),
    `style-src 'self' 'unsafe-inline' ${resources.join(" ")}`.trim(),
    `img-src 'self' data: ${resources.join(" ")}`.trim(),
    `media-src 'self' data: ${resources.join(" ")}`.trim(),
    `connect-src ${sources(connections)}`,
    `frame-src ${sources(frames)}`,
    `base-uri ${bases.length > 0 ? bases.join(" ") : "'self'"}`,
    "object-src 'none'",
    "form-action 'none'",
  ];
  if (csp) {
    directives.splice(5, 0, `font-src 'self' ${resources.join(" ")}`.trim());
  }
  return directives.join("; ");
}
