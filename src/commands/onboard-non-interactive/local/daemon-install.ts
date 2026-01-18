import type { ClawdbotConfig } from "../../../config/config.js";
import { resolveGatewayService } from "../../../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../../../daemon/systemd.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME, isGatewayDaemonRuntime } from "../../daemon-runtime.js";
import { buildGatewayInstallPlan, gatewayInstallErrorHint } from "../../daemon-install-helpers.js";
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
    runtime.log("Systemd user services are unavailable; skipping daemon install.");
    return;
  }

  if (!isGatewayDaemonRuntime(daemonRuntimeRaw)) {
    runtime.error("Invalid --daemon-runtime (use node or bun)");
    runtime.exit(1);
    return;
  }

  const service = resolveGatewayService();
  const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
    env: process.env,
    port,
    token: gatewayToken,
    runtime: daemonRuntimeRaw,
    warn: (message) => runtime.log(message),
  });
  try {
    await service.install({
      env: process.env,
      stdout: process.stdout,
      programArguments,
      workingDirectory,
      environment,
    });
  } catch (err) {
    runtime.error(`Gateway daemon install failed: ${String(err)}`);
    runtime.log(gatewayInstallErrorHint());
    return;
  }
  await ensureSystemdUserLingerNonInteractive({ runtime });
}
