export function resolveGatewayHttpOrigin(gatewayUrl: string, hostOrigin: string): string {
  const gateway = new URL(gatewayUrl || hostOrigin, hostOrigin);
  if (gateway.protocol === "ws:") {
    gateway.protocol = "http:";
  } else if (gateway.protocol === "wss:") {
    gateway.protocol = "https:";
  }
  if (gateway.protocol !== "http:" && gateway.protocol !== "https:") {
    throw new Error("Gateway URL is invalid");
  }
  return gateway.origin;
}

export function resolveSandboxHostUrl(
  value: string,
  sandboxPort: number,
  sandboxOrigin: string | undefined,
  gatewayUrl: string,
  hostOrigin: string,
  invalidMessage = "Sandbox host URL is invalid",
): string {
  if (!Number.isInteger(sandboxPort) || sandboxPort < 1 || sandboxPort > 65535) {
    throw new Error(invalidMessage);
  }
  let activeGatewayOrigin: string;
  try {
    activeGatewayOrigin = resolveGatewayHttpOrigin(gatewayUrl, hostOrigin);
  } catch {
    throw new Error(invalidMessage);
  }
  const base = sandboxOrigin ? new URL(sandboxOrigin) : new URL(activeGatewayOrigin);
  if (sandboxOrigin) {
    if (
      base.origin !== sandboxOrigin.replace(/\/$/u, "") ||
      base.username !== "" ||
      base.password !== ""
    ) {
      throw new Error(invalidMessage);
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
    throw new Error(invalidMessage);
  }
  return resolved.href;
}
