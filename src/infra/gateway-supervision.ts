// Defines gateway lifecycle ownership shared by service, restart, and update paths.
const GATEWAY_SUPERVISOR_MODE_ENV = "OPENCLAW_SUPERVISOR_MODE";
export const EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON = "external-supervisor-update-required";

type GatewaySupervisorMode = "auto" | "external";

function resolveGatewaySupervisorMode(env: NodeJS.ProcessEnv = process.env): GatewaySupervisorMode {
  return env[GATEWAY_SUPERVISOR_MODE_ENV]?.trim().toLowerCase() === "external"
    ? "external"
    : "auto";
}

export function isGatewayExternallySupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveGatewaySupervisorMode(env) === "external";
}

export function formatExternalSupervisorActionRequired(action: string): string {
  return [
    `OpenClaw gateway lifecycle is managed by an external supervisor (${GATEWAY_SUPERVISOR_MODE_ENV}=external).`,
    `Use that supervisor to ${action}.`,
  ].join(" ");
}

export function formatExternalSupervisorUpdateRequired(): string {
  return [
    `OpenClaw self-update is disabled while gateway lifecycle is managed by an external supervisor (${GATEWAY_SUPERVISOR_MODE_ENV}=external).`,
    "Use the external supervisor's update workflow so it can stop the gateway, update and finalize the runtime, then restart it safely.",
  ].join(" ");
}

export function assertGatewayServiceMutationAllowed(
  action: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isGatewayExternallySupervised(env)) {
    throw new Error(formatExternalSupervisorActionRequired(action));
  }
}
