import { buildGatewayInstallPlan } from "../../commands/daemon-install-helpers.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME } from "../../commands/daemon-runtime.js";
import { resolveGatewayInstallToken } from "../../commands/gateway-install-token.js";
import { readConfigFileSnapshotForWrite } from "../../config/io.js";
import { resolveGatewayPort } from "../../config/paths.js";
import { OPENCLAW_WRAPPER_ENV_KEY, resolveOpenClawWrapperPath } from "../../daemon/program-args.js";
import type { GatewayServiceEnv } from "../../daemon/service-types.js";
import type {
  GatewayService,
  GatewayServiceStartRepairIssue,
  GatewayServiceState,
} from "../../daemon/service.js";
import { formatGatewayServiceStartRepairIssues } from "../../daemon/service.js";
import { defaultRuntime } from "../../runtime.js";
import { mergeInstallInvocationEnv } from "./install.js";

export async function repairLoadedGatewayServiceForStart(params: {
  service: GatewayService;
  state: GatewayServiceState;
  issues: GatewayServiceStartRepairIssue[];
  json: boolean;
  stdout: NodeJS.WritableStream;
}): Promise<{ result: "started"; message: string; warnings?: string[]; loaded: boolean }> {
  const { snapshot: configSnapshot, writeOptions: configWriteOptions } =
    await readConfigFileSnapshotForWrite();
  const cfg = configSnapshot.valid ? configSnapshot.sourceConfig : configSnapshot.config;
  const existingEnvironment = params.state.command?.environment;
  const installEnv = mergeInstallInvocationEnv({
    env: process.env,
    existingServiceEnv: existingEnvironment,
  });
  const wrapperPath = await resolveOpenClawWrapperPath(installEnv[OPENCLAW_WRAPPER_ENV_KEY]);
  const port = resolveGatewayPort(cfg);

  const tokenResolution = await resolveGatewayInstallToken({
    config: cfg,
    configSnapshot,
    configWriteOptions,
    env: installEnv,
    autoGenerateWhenMissing: true,
    persistGeneratedToken: true,
  });
  if (tokenResolution.unavailableReason) {
    throw new Error(tokenResolution.unavailableReason);
  }

  const warnings = [
    formatGatewayServiceStartRepairIssues(params.issues),
    ...tokenResolution.warnings,
  ].filter((warning) => warning.trim().length > 0);
  if (!params.json) {
    defaultRuntime.log("Gateway service definition needs repair:");
    for (const warning of warnings) {
      defaultRuntime.log(`- ${warning}`);
    }
  }

  const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
    env: installEnv,
    port,
    runtime: DEFAULT_GATEWAY_DAEMON_RUNTIME,
    wrapperPath,
    existingEnvironment,
    config: cfg,
    warn: (message) => {
      warnings.push(message);
      if (!params.json) {
        defaultRuntime.log(`- ${message}`);
      }
    },
  });

  await params.service.install({
    env: installEnv as GatewayServiceEnv,
    stdout: params.stdout,
    programArguments,
    workingDirectory,
    environment,
  });

  let loaded = true;
  try {
    loaded = await params.service.isLoaded({ env: installEnv });
  } catch {
    loaded = true;
  }

  return {
    result: "started",
    message: "Gateway service definition repaired and started.",
    warnings: warnings.length ? warnings : undefined,
    loaded,
  };
}
