import {
  appendGatewayLifecycleAuditLog,
  type GatewayLifecycleAuditSource,
} from "../../daemon/restart-logs.js";
import { createGatewayLifecycleMutationReporter } from "../../daemon/service-mutation.js";
/** Gateway lifecycle audit helpers shared by managed and unmanaged CLI paths. */
import type { GatewayLifecycleMutation } from "../../daemon/service-types.js";
import type { GatewayLifecycleMutationMode } from "../../daemon/service-types.js";
import { isTerminalInteractive } from "../terminal-interactivity.js";

type GatewayLifecycleAction = "start" | "stop" | "restart";

export function appendGatewayLifecycleAudit(params: {
  action: GatewayLifecycleAction;
  source: GatewayLifecycleAuditSource;
  mode: GatewayLifecycleMutationMode;
  pid?: number;
  env?: NodeJS.ProcessEnv;
}): void {
  appendGatewayLifecycleAuditLog(params.env ?? process.env, {
    action: params.action,
    source: params.source,
    mode: params.mode,
    ...(params.pid === undefined ? {} : { pid: params.pid }),
    interactive: isTerminalInteractive(),
  });
}

export function createGatewayLifecycleMutationAudit(params: {
  action: GatewayLifecycleAction;
  source?: GatewayLifecycleAuditSource;
  env?: NodeJS.ProcessEnv;
}): (mutation: GatewayLifecycleMutation) => void {
  const reportMutation = createGatewayLifecycleMutationReporter((mutation) => {
    appendGatewayLifecycleAudit({
      action: params.action,
      source: params.source ?? "cli",
      mode: mutation.mode,
      ...(params.env === undefined ? {} : { env: params.env }),
    });
  });
  return (mutation) => reportMutation(mutation.mode);
}

export function createServiceLifecycleMutationAudit(params: {
  serviceNoun: string;
  action: GatewayLifecycleAction;
}): ((mutation: GatewayLifecycleMutation) => void) | undefined {
  return params.serviceNoun === "Gateway"
    ? createGatewayLifecycleMutationAudit({ action: params.action })
    : undefined;
}

export function appendServiceLifecycleRepairAudit(params: {
  serviceNoun: string;
  action: "start" | "restart";
  pid?: number;
}): void {
  if (params.serviceNoun !== "Gateway") {
    return;
  }
  appendGatewayLifecycleAudit({
    action: params.action,
    source: "cli",
    mode: "service-repair",
    ...(params.pid === undefined ? {} : { pid: params.pid }),
  });
}
