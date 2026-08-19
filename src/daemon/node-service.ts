/** Adapts the generic gateway service manager for OpenClaw node-host services. */
import { resolveNodeServiceIdentityEnvironment } from "./constants.js";
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
    ...resolveNodeServiceIdentityEnvironment(),
  };
}

function withNodeInstallEnv(args: GatewayServiceInstallArgs): GatewayServiceInstallArgs {
  return {
    ...args,
    env: withNodeServiceEnv(args.env),
    environment: withNodeServiceEnv(args.environment ?? {}),
  };
}

/** Returns a service controller bound to node-host labels across all platforms. */
export function resolveNodeService(): GatewayService {
  const base = resolveGatewayService();
  const hasInstalledDefinition = base.hasInstalledDefinition;
  return {
    ...base,
    stage: (args) => base.stage(withNodeInstallEnv(args)),
    install: (args) => base.install(withNodeInstallEnv(args)),
    uninstall: (args) => base.uninstall({ ...args, env: withNodeServiceEnv(args.env) }),
    start: (args) => base.start({ ...args, env: withNodeServiceEnv(args.env ?? {}) }),
    stop: (args) => base.stop({ ...args, env: withNodeServiceEnv(args.env ?? {}) }),
    restart: (args) => base.restart({ ...args, env: withNodeServiceEnv(args.env ?? {}) }),
    isLoaded: (args) => {
      // Preserve the status read deadline so node probes fail soft under a
      // wedged service manager instead of hanging the whole status command.
      return base.isLoaded({ env: withNodeServiceEnv(args.env ?? {}), timeoutMs: args.timeoutMs });
    },
    hasInstalledDefinition: hasInstalledDefinition
      ? (args) => hasInstalledDefinition({ ...args, env: withNodeServiceEnv(args.env ?? {}) })
      : undefined,
    readCommand: (env) => base.readCommand(withNodeServiceEnv(env)),
    readRuntime: (env, opts) => base.readRuntime(withNodeServiceEnv(env), opts),
  };
}
