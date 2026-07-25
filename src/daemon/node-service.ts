/** Adapts the generic gateway service manager for OpenClaw node-host services. */
import {
  NODE_SERVICE_KIND,
  NODE_SERVICE_MARKER,
  NODE_WINDOWS_TASK_SCRIPT_NAME,
  resolveNodeLaunchAgentLabel,
  resolveNodeSystemdServiceName,
  resolveNodeWindowsTaskName,
} from "./constants.js";
import type { GatewayService, GatewayServiceInstallArgs } from "./service.js";
import { resolveGatewayService } from "./service.js";

// Wraps the generic gateway service with node-specific service identifiers and env.
function withNodeServiceEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  // Node services reuse gateway platform installers; env overrides select the
  // node-specific labels, logs, task script, and service marker.
  return {
    ...env,
    OPENCLAW_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
    OPENCLAW_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
    OPENCLAW_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
    OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
    OPENCLAW_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
    OPENCLAW_LOG_PREFIX: "node",
    OPENCLAW_SERVICE_MARKER: NODE_SERVICE_MARKER,
    OPENCLAW_SERVICE_KIND: NODE_SERVICE_KIND,
  };
}

function withNodeInstallEnv(args: GatewayServiceInstallArgs): GatewayServiceInstallArgs {
  return {
    ...args,
    env: withNodeServiceEnv(args.env),
    environment: {
      ...args.environment,
      OPENCLAW_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
      OPENCLAW_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
      OPENCLAW_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
      OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
      OPENCLAW_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
      OPENCLAW_LOG_PREFIX: "node",
      OPENCLAW_SERVICE_MARKER: NODE_SERVICE_MARKER,
      OPENCLAW_SERVICE_KIND: NODE_SERVICE_KIND,
    },
  };
}

/** Returns a service controller bound to node-host labels across all platforms. */
export function resolveNodeService(): GatewayService {
  const base = resolveGatewayService();
  return {
    ...base,
    stage: async (args) => {
      return base.stage(withNodeInstallEnv(args));
    },
    install: async (args) => {
      return base.install(withNodeInstallEnv(args));
    },
    uninstall: async (args) => {
      return base.uninstall({ ...args, env: withNodeServiceEnv(args.env) });
    },
    start: async (args) => {
      return base.start({ ...args, env: withNodeServiceEnv(args.env ?? {}) });
    },
    stop: async (args) => {
      return base.stop({ ...args, env: withNodeServiceEnv(args.env ?? {}) });
    },
    restart: async (args) => {
      return base.restart({ ...args, env: withNodeServiceEnv(args.env ?? {}) });
    },
    isLoaded: async (args) => {
      // Preserve the status read deadline so node probes fail soft under a
      // wedged service manager instead of hanging the whole status command.
      return base.isLoaded({ env: withNodeServiceEnv(args.env ?? {}), timeoutMs: args.timeoutMs });
    },
    readCommand: (env) => base.readCommand(withNodeServiceEnv(env)),
    readRuntime: (env, opts) => base.readRuntime(withNodeServiceEnv(env), opts),
  };
}
