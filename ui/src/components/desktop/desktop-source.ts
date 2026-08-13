import type { DesktopSource, EnvironmentSummary } from "@openclaw/gateway-protocol";

export function desktopSourceForEnvironment(
  environment: Pick<EnvironmentSummary, "id">,
): DesktopSource {
  if (environment.id === "gateway") {
    return { kind: "host" };
  }
  if (environment.id.startsWith("node:") && environment.id.length > "node:".length) {
    return { kind: "node", nodeId: environment.id.slice("node:".length) };
  }
  return { kind: "environment", environmentId: environment.id };
}
