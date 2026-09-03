import { isConfiguredCommandOwner } from "../../auto-reply/command-auth.js";
import {
  readBestEffortConfig,
  readConfigFileSnapshot,
  resolveGatewayPort,
} from "../../config/config.js";
import { createConfigIO } from "../../config/io.js";
import { mergeGatewayServiceEnv } from "../../daemon/service-env-merge.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { parseTcpPortFromArgs } from "../../infra/tcp-port.js";
import { ensureCliPluginRegistryLoaded } from "../plugin-registry-loader.js";
import { waitForGatewayHealthyRestart } from "./restart-health.js";

export async function resolveGatewayLifecycleContext(
  service = resolveGatewayService(),
  requireEffective = false,
) {
  const command = requireEffective
    ? await service.readCommand(process.env, { requireEffective: true })
    : await service.readCommand(process.env).catch(() => null);
  if (requireEffective && !command) {
    throw new Error(
      "Updated gateway service could not be inspected; run `openclaw gateway status --deep`.",
    );
  }
  const env = mergeGatewayServiceEnv(process.env, command);
  const config = await createConfigIO({
    env,
    observe: false,
    pluginValidation: "skip",
    suppressFutureVersionWarning: true,
  })
    .readBestEffortConfig()
    .catch(() => undefined);
  const port = parseTcpPortFromArgs(command?.programArguments) ?? resolveGatewayPort(config, env);
  return { port, env, config, command };
}

export async function resolveGatewayConfigPorts() {
  const config = await readBestEffortConfig({ observe: false }).catch(() => undefined);
  return { explicit: config?.gateway?.port, fallback: resolveGatewayPort(config, process.env) };
}

// The detached update helper imports this through the stable daemon CLI entry.
// Native manager acceptance alone never proves that a restored Gateway is ready.
export async function waitForGatewayUpdateRecovery(
  expectedVersion: string,
  expectedBuildId?: string,
) {
  if (!expectedVersion?.trim()) {
    throw new Error("Recovery Gateway version is unavailable.");
  }
  const service = resolveGatewayService();
  const { port, env } = await resolveGatewayLifecycleContext(service, true);
  return await waitForGatewayHealthyRestart({
    service,
    port,
    env,
    expectedVersion,
    expectedBuildId,
    requireRunningService: true,
    settle: { probes: 12 },
  });
}

// The helper rechecks external chat authority after parent exit and service stop.
export async function isManagedUpdateRequesterOwner(
  requester: Parameters<typeof isConfiguredCommandOwner>[1],
) {
  await ensureCliPluginRegistryLoaded({ scope: "configured-channels", routeLogsToStderr: true });
  const snapshot = await readConfigFileSnapshot({ observe: false, skipPluginValidation: true });
  return snapshot.valid && isConfiguredCommandOwner(snapshot.config, requester);
}
