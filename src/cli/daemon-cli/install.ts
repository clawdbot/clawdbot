import path from "node:path";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
} from "../../commands/daemon-runtime.js";
import { loadConfig, resolveGatewayPort } from "../../config/config.js";
import { resolveIsNixMode } from "../../config/paths.js";
import { resolveGatewayLaunchAgentLabel } from "../../daemon/constants.js";
import { resolveGatewayProgramArguments } from "../../daemon/program-args.js";
import {
  renderSystemNodeWarning,
  resolvePreferredNodePath,
  resolveSystemNodeInfo,
} from "../../daemon/runtime-paths.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { buildServiceEnvironment } from "../../daemon/service-env.js";
import { defaultRuntime } from "../../runtime.js";
import { parsePort } from "./shared.js";
import type { DaemonInstallOptions } from "./types.js";

export async function runDaemonInstall(opts: DaemonInstallOptions) {
  if (resolveIsNixMode(process.env)) {
    defaultRuntime.error("Nix mode detected; daemon install is disabled.");
    defaultRuntime.exit(1);
    return;
  }

  const cfg = loadConfig();
  const portOverride = parsePort(opts.port);
  if (opts.port !== undefined && portOverride === null) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
    return;
  }
  const port = portOverride ?? resolveGatewayPort(cfg);
  if (!Number.isFinite(port) || port <= 0) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
    return;
  }
  const runtimeRaw = opts.runtime ? String(opts.runtime) : DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (!isGatewayDaemonRuntime(runtimeRaw)) {
    defaultRuntime.error('Invalid --runtime (use "node" or "bun")');
    defaultRuntime.exit(1);
    return;
  }

  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    defaultRuntime.error(`Gateway service check failed: ${String(err)}`);
    defaultRuntime.exit(1);
    return;
  }
  if (loaded) {
    if (!opts.force) {
      defaultRuntime.log(`Gateway service already ${service.loadedText}.`);
      defaultRuntime.log("Reinstall with: clawdbot daemon install --force");
      return;
    }
  }

  const devMode =
    process.argv[1]?.includes(`${path.sep}src${path.sep}`) && process.argv[1]?.endsWith(".ts");
  const nodePath = await resolvePreferredNodePath({
    env: process.env,
    runtime: runtimeRaw,
  });
  const { programArguments, workingDirectory } = await resolveGatewayProgramArguments({
    port,
    dev: devMode,
    runtime: runtimeRaw,
    nodePath,
  });
  if (runtimeRaw === "node") {
    const systemNode = await resolveSystemNodeInfo({ env: process.env });
    const warning = renderSystemNodeWarning(systemNode, programArguments[0]);
    if (warning) defaultRuntime.log(warning);
  }
  const environment = buildServiceEnvironment({
    env: process.env,
    port,
    token: opts.token || cfg.gateway?.auth?.token || process.env.CLAWDBOT_GATEWAY_TOKEN,
    launchdLabel:
      process.platform === "darwin"
        ? resolveGatewayLaunchAgentLabel(process.env.CLAWDBOT_PROFILE)
        : undefined,
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
    defaultRuntime.error(`Gateway install failed: ${String(err)}`);
    defaultRuntime.exit(1);
  }
}
