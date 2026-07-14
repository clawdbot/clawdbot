import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";

type McpAppHostCapabilities = ConstructorParameters<typeof AppBridge>[2];
export type McpAppHostSandboxCsp = NonNullable<
  NonNullable<McpAppHostCapabilities["sandbox"]>["csp"]
>;

export function buildMcpAppHostCapabilities(csp?: McpAppHostSandboxCsp): McpAppHostCapabilities {
  return {
    openLinks: {},
    serverResources: {},
    serverTools: {},
    sandbox: { csp: csp ?? {} },
  };
}

export function resolveMcpAppSandboxUrl(
  value: string,
  sandboxPort: number,
  sandboxOrigin: string | undefined,
  gatewayUrl: string,
  hostOrigin: string,
): string {
  if (!Number.isInteger(sandboxPort) || sandboxPort < 1 || sandboxPort > 65535) {
    throw new Error("MCP App sandbox port is invalid");
  }
  const gateway = new URL(gatewayUrl || hostOrigin, hostOrigin);
  if (gateway.protocol === "ws:") {
    gateway.protocol = "http:";
  } else if (gateway.protocol === "wss:") {
    gateway.protocol = "https:";
  }
  if (gateway.protocol !== "http:" && gateway.protocol !== "https:") {
    throw new Error("MCP App sandbox URL is invalid");
  }
  const activeGatewayOrigin = gateway.origin;
  const base = sandboxOrigin ? new URL(sandboxOrigin) : new URL(activeGatewayOrigin);
  if (sandboxOrigin) {
    if (
      base.origin !== sandboxOrigin.replace(/\/$/u, "") ||
      base.username !== "" ||
      base.password !== ""
    ) {
      throw new Error("MCP App sandbox URL is invalid");
    }
  } else {
    base.port = String(sandboxPort);
  }
  base.pathname = "/";
  base.search = "";
  base.hash = "";
  const resolved = new URL(value, base);
  if (
    (base.protocol !== "http:" && base.protocol !== "https:") ||
    base.origin === new URL(hostOrigin).origin ||
    base.origin === activeGatewayOrigin ||
    resolved.origin !== base.origin ||
    resolved.pathname !== "/mcp-app-sandbox"
  ) {
    throw new Error("MCP App sandbox URL is invalid");
  }
  return resolved.href;
}
