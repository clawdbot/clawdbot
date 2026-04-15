import { runCommandWithRuntime } from "../cli/cli-utils.js";
import { callGatewayFromCli, type GatewayRpcOpts } from "../cli/gateway-rpc.js";
import { respondUnavailableOnNodeInvokeError, safeParseJson } from "../gateway/server-methods/nodes.helpers.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/types.js";
import { ErrorCodes, errorShape } from "../gateway/protocol/schema/error-codes.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../gateway/node-command-policy.js";
import type { NodeSession } from "../gateway/node-registry.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { ensureGatewayStartupAuth } from "../gateway/startup-auth.js";
import { rawDataToString } from "../infra/ws.js";
import type { OpenClawPluginService } from "../plugins/types.js";
import { runExec } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import { withTimeout } from "../node-host/with-timeout.js";

export {
  callGatewayFromCli,
  defaultRuntime,
  ensureGatewayStartupAuth,
  ErrorCodes,
  errorShape,
  isNodeCommandAllowed,
  rawDataToString,
  resolveGatewayAuth,
  resolveNodeCommandAllowlist,
  respondUnavailableOnNodeInvokeError,
  runCommandWithRuntime,
  runExec,
  safeParseJson,
  withTimeout,
};

export type { GatewayRequestHandlers, GatewayRpcOpts, NodeSession, OpenClawPluginService };

export type LazyPluginServiceHandle = {
  stop: () => Promise<void>;
};

export async function startLazyPluginServiceModule(params: {
  skipEnvVar?: string;
  overrideEnvVar?: string;
  validateOverrideSpecifier?: (specifier: string) => string;
  loadDefaultModule: () => Promise<Record<string, unknown>>;
  startExportNames: string[];
  stopExportNames?: string[];
}): Promise<LazyPluginServiceHandle | null> {
  if (params.skipEnvVar && process.env[params.skipEnvVar]?.trim()) {
    return null;
  }

  const overrideSpecifier = params.overrideEnvVar ? process.env[params.overrideEnvVar]?.trim() : undefined;
  const moduleExports = overrideSpecifier
    ? await import(params.validateOverrideSpecifier ? params.validateOverrideSpecifier(overrideSpecifier) : overrideSpecifier)
    : await params.loadDefaultModule();

  for (const exportName of params.startExportNames) {
    const startFn = moduleExports[exportName];
    if (typeof startFn === "function") {
      await startFn();
      return {
        stop: async () => {
          for (const stopExportName of params.stopExportNames ?? []) {
            const stopFn = moduleExports[stopExportName];
            if (typeof stopFn === "function") {
              await stopFn();
              return;
            }
          }
        },
      };
    }
  }

  return {
    stop: async () => {
      for (const stopExportName of params.stopExportNames ?? []) {
        const stopFn = moduleExports[stopExportName];
        if (typeof stopFn === "function") {
          await stopFn();
          return;
        }
      }
    },
  };
}
