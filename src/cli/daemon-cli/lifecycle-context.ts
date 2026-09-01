import { readBestEffortConfig, resolveGatewayPort } from "../../config/config.js";
import { createConfigIO } from "../../config/io.js";
import { mergeGatewayServiceEnv } from "../../daemon/service-env-merge.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { parseTcpPortFromArgs } from "../../infra/tcp-port.js";

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
