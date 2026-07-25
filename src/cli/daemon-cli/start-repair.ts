// Start-time service repair: rebuilds stale service definitions before starting Gateway.
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
import { parseTcpPort, parseTcpPortFromArgs } from "../../infra/tcp-port.js";
import { defaultRuntime } from "../../runtime.js";
import { mergeInstallInvocationEnv } from "./install.js";

type GatewayServiceRepairParams = {
  service: GatewayService;
  port?: number;
  state: GatewayServiceState;
  issues: GatewayServiceStartRepairIssue[];
  json: boolean;
  stdout: NodeJS.WritableStream;
  warn?: (message: string) => void;
};

type GatewayServiceRepairResult<TResult extends "restarted" | "started"> = {
  result: TResult;
  message: string;
  warnings?: string[];
  loaded: boolean;
};

/** Repair a loaded but stale Gateway service definition and report the start result. */
export function repairLoadedGatewayServiceForStart(
  params: GatewayServiceRepairParams & { action: "restart" },
): Promise<GatewayServiceRepairResult<"restarted">>;
export function repairLoadedGatewayServiceForStart(
  params: GatewayServiceRepairParams & { action?: "start" },
): Promise<GatewayServiceRepairResult<"started">>;
export async function repairLoadedGatewayServiceForStart(
  params: GatewayServiceRepairParams & { action?: "restart" | "start" },
): Promise<{
  result: "restarted" | "started";
  message: string;
  warnings?: string[];
  loaded: boolean;
}> {
  const { snapshot: configSnapshot, writeOptions: configWriteOptions } =
    await readConfigFileSnapshotForWrite();
  const cfg = configSnapshot.valid ? configSnapshot.sourceConfig : configSnapshot.config;
  const existingEnvironment = params.state.command?.environment;
  const existingEnvironmentValueSources = params.state.command?.environmentValueSources;
  const installEnv = mergeInstallInvocationEnv({
    env: process.env,
    existingServiceEnv: existingEnvironment,
  });
  const wrapperPath = await resolveOpenClawWrapperPath(installEnv[OPENCLAW_WRAPPER_ENV_KEY]);
  const installedPort =
    parseTcpPortFromArgs(params.state.command?.programArguments) ??
    parseTcpPort(params.state.command?.environment?.OPENCLAW_GATEWAY_PORT);
  const port = params.port ?? installedPort ?? resolveGatewayPort(cfg);

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

  const { programArguments, workingDirectory, environment, environmentValueSources } =
    await buildGatewayInstallPlan({
      env: installEnv,
      port,
      runtime: DEFAULT_GATEWAY_DAEMON_RUNTIME,
      wrapperPath,
      existingEnvironment,
      existingEnvironmentValueSources,
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
    warn: params.warn,
    programArguments,
    workingDirectory,
    environment,
    environmentValueSources,
  });

  let loaded;
  try {
    loaded = await params.service.isLoaded({ env: installEnv });
  } catch {
    loaded = true;
  }

  return {
    result: params.action === "restart" ? "restarted" : "started",
    message:
      params.action === "restart"
        ? "Gateway service definition repaired and restarted."
        : "Gateway service definition repaired and started. Reopen the Control UI with `openclaw dashboard` or copy a fresh auth URL with `openclaw dashboard --no-open`.",
    warnings: warnings.length ? warnings : undefined,
    loaded,
  };
}
