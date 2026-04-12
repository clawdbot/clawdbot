import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveGatewayService } from "../../../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../../../daemon/systemd.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { buildGatewayInstallPlan, gatewayInstallErrorHint } from "../../daemon-install-helpers.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME, isGatewayDaemonRuntime } from "../../daemon-runtime.js";
import { resolveGatewayInstallToken } from "../../gateway-install-token.js";
import type { OnboardOptions } from "../../onboard-types.js";
import { ensureSystemdUserLingerNonInteractive } from "../../systemd-linger.js";

export async function installGatewayDaemonNonInteractive(params: {
  nextConfig: OpenClawConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  port: number;
}): Promise<
  | {
      installed: true;
    }
  | {
      installed: false;
      skippedReason?: "systemd-user-unavailable";
    }
> {
  const { opts, runtime, port } = params;
  if (!opts.installDaemon) {
    return { installed: false };
  }

  const daemonRuntimeRaw = opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  const systemdAvailable =
    process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
  if (process.platform === "linux" && !systemdAvailable) {
    runtime.log(
      "Systemd user services are unavailable; skipping service install. Use a direct shell run (`openclaw gateway run`) or rerun without --install-daemon on this session.",
    );
    return { installed: false, skippedReason: "systemd-user-unavailable" };
  }

  if (!isGatewayDaemonRuntime(daemonRuntimeRaw)) {
    runtime.error("Invalid --daemon-runtime (use node or bun)");
    runtime.exit(1);
    return { installed: false };
  }

  const service = resolveGatewayService();
  const tokenResolution = await resolveGatewayInstallToken({
    config: params.nextConfig,
    env: process.env,
  });
  for (const warning of tokenResolution.warnings) {
    runtime.log(warning);
  }
  if (tokenResolution.unavailableReason) {
    runtime.error(
      [
        "Gateway install blocked:",
        tokenResolution.unavailableReason,
        "Fix gateway auth config/token input and rerun setup.",
      ].join(" "),
    );
    runtime.exit(1);
    return { installed: false };
  }
  const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
    env: process.env,
    port,
    runtime: daemonRuntimeRaw,
    warn: (message) => runtime.log(message),
    config: params.nextConfig,
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
    runtime.error(`Gateway service install failed: ${String(err)}`);
    runtime.log(gatewayInstallErrorHint());
    return { installed: false };
  }
  await ensureSystemdUserLingerNonInteractive({ runtime });
  return { installed: true };
}
