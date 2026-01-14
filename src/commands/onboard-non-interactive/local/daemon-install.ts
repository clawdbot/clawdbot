import path from "node:path";

import type { ClawdbotConfig } from "../../../config/config.js";
import { resolveGatewayLaunchAgentLabel } from "../../../daemon/constants.js";
import { resolveGatewayProgramArguments } from "../../../daemon/program-args.js";
import {
  renderSystemNodeWarning,
  resolvePreferredNodePath,
  resolveSystemNodeInfo,
} from "../../../daemon/runtime-paths.js";
import { resolveGatewayService } from "../../../daemon/service.js";
import { buildServiceEnvironment } from "../../../daemon/service-env.js";
import { isSystemdUserServiceAvailable } from "../../../daemon/systemd.js";
import type { RuntimeEnv } from "../../../runtime.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
} from "../../daemon-runtime.js";
import type { OnboardOptions } from "../../onboard-types.js";
import { ensureSystemdUserLingerNonInteractive } from "../../systemd-linger.js";

export async function installGatewayDaemonNonInteractive(params: {
  nextConfig: ClawdbotConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  port: number;
  gatewayToken?: string;
}) {
  const { opts, runtime, port, gatewayToken } = params;
  if (!opts.installDaemon) return;

  const daemonRuntimeRaw = opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  const systemdAvailable =
    process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
  if (process.platform === "linux" && !systemdAvailable) {
    runtime.log(
      "Systemd user services are unavailable; skipping daemon install.",
    );
    return;
  }

  if (!isGatewayDaemonRuntime(daemonRuntimeRaw)) {
    runtime.error("Invalid --daemon-runtime (use node or bun)");
    runtime.exit(1);
    return;
  }

  const service = resolveGatewayService();
  const devMode =
    process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
    process.argv[1]?.endsWith(".ts");
  const nodePath = await resolvePreferredNodePath({
    env: process.env,
    runtime: daemonRuntimeRaw,
  });
  const { programArguments, workingDirectory } =
    await resolveGatewayProgramArguments({
      port,
      dev: devMode,
      runtime: daemonRuntimeRaw,
      nodePath,
    });

  if (daemonRuntimeRaw === "node") {
    const systemNode = await resolveSystemNodeInfo({ env: process.env });
    const warning = renderSystemNodeWarning(systemNode, programArguments[0]);
    if (warning) runtime.log(warning);
  }

  const environment = buildServiceEnvironment({
    env: process.env,
    port,
    token: gatewayToken,
    launchdLabel:
      process.platform === "darwin"
        ? resolveGatewayLaunchAgentLabel(process.env.CLAWDBOT_PROFILE)
        : undefined,
  });
  await service.install({
    env: process.env,
    stdout: process.stdout,
    programArguments,
    workingDirectory,
    environment,
  });
  await ensureSystemdUserLingerNonInteractive({ runtime });
}
