// Start-time service repair: rebuilds stale service definitions before starting Gateway.
import path from "node:path";
import { buildGatewayInstallPlan } from "../../commands/daemon-install-helpers.js";
import { resolveGatewayDaemonRuntime } from "../../commands/daemon-runtime.js";
import { resolveGatewayInstallToken } from "../../commands/gateway-install-token.js";
import { readConfigFileSnapshotForWrite } from "../../config/io.js";
import {
  resolveConfigPathCandidate,
  resolveGatewayPort,
  resolveStateDir,
} from "../../config/paths.js";
import { OPENCLAW_WRAPPER_ENV_KEY, resolveOpenClawWrapperPath } from "../../daemon/program-args.js";
import { resolveBunRuntimeInfo } from "../../daemon/runtime-paths.js";
import {
  assertServiceDefinitionWritable,
  hasGatewayServiceEnvironmentDifference,
  hasGatewayServiceLauncherOverride,
  resolveManagedGatewayServiceCommand,
  type GatewayServiceEnv,
} from "../../daemon/service-types.js";
import type {
  GatewayService,
  GatewayServiceStartRepairIssue,
  GatewayServiceState,
} from "../../daemon/service.js";
import { formatGatewayServiceStartRepairIssues } from "../../daemon/service.js";
import { assertGatewayServiceMutationAllowed } from "../../infra/gateway-supervision.js";
import { parseTcpPortFromArgs } from "../../infra/tcp-port.js";
import { defaultRuntime } from "../../runtime.js";
import { mergeInstallInvocationEnv } from "./install.js";

type GatewayServiceRepairParams = {
  service: Pick<GatewayService, "install" | "isLoaded" | "readDefinitionMutationCapability">;
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

const GATEWAY_TARGET_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "OPENCLAW_HOME",
  "OPENCLAW_PROFILE",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_PORT",
] as const;

function resolveInstalledGatewayTargetEnvironment(
  existingEnvironment: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const installedEnv: NodeJS.ProcessEnv = {};
  for (const key of GATEWAY_TARGET_ENV_KEYS) {
    const value = existingEnvironment?.[key]?.trim();
    if (value) {
      installedEnv[key] = value;
    }
  }
  return installedEnv;
}

function normalizeTargetPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// Start/restart may rewrite a stale service. Refuse before planning when that
// rewrite would adopt a different state, config, or port from the invoking shell.
function assertGatewayRepairTargetMatches(params: {
  action: "restart" | "start";
  config: Parameters<typeof resolveGatewayPort>[0];
  existingEnvironment: Record<string, string> | undefined;
  installedPort: number | null;
}): number {
  const installedEnv = resolveInstalledGatewayTargetEnvironment(params.existingEnvironment);
  const installedStateOverride = installedEnv.OPENCLAW_STATE_DIR?.trim();
  const installedHome =
    installedEnv.OPENCLAW_HOME?.trim() ||
    installedEnv.HOME?.trim() ||
    installedEnv.USERPROFILE?.trim();
  if (!installedStateOverride && !installedHome) {
    throw new Error(
      `Refusing to repair the managed Gateway service because its installed state directory cannot be determined from the service definition. Run \`openclaw gateway install --force\` to replace it intentionally.`,
    );
  }
  const installedStateDir = resolveStateDir(installedEnv);
  const installedConfigPath = resolveConfigPathCandidate(installedEnv);
  const ambientStateDir = resolveStateDir(process.env);
  const ambientConfigPath = resolveConfigPathCandidate(process.env);
  const ambientPort = resolveGatewayPort(params.config, process.env);
  const sameConfigPath =
    normalizeTargetPath(installedConfigPath) === normalizeTargetPath(ambientConfigPath);
  const installedPort =
    params.installedPort ??
    (sameConfigPath ? resolveGatewayPort(params.config, installedEnv) : null);
  const differences: Array<{ name: string; installed: string; ambient: string }> = [];

  for (const [name, installed, ambient] of [
    ["OPENCLAW_STATE_DIR", installedStateDir, ambientStateDir],
    ["OPENCLAW_CONFIG_PATH", installedConfigPath, ambientConfigPath],
  ] as const) {
    if (normalizeTargetPath(installed) !== normalizeTargetPath(ambient)) {
      differences.push({ name, installed, ambient });
    }
  }
  if (installedPort !== null && installedPort !== ambientPort) {
    differences.push({
      name: "gateway.port",
      installed: String(installedPort),
      ambient: String(ambientPort),
    });
  }
  if (differences.length === 0) {
    return installedPort ?? ambientPort;
  }

  const details = differences
    .map(
      ({ name, installed, ambient }) =>
        `- ${name}: installed=${JSON.stringify(installed)}, ambient=${JSON.stringify(ambient)}`,
    )
    .join("\n");
  throw new Error(
    `Refusing to repair the managed Gateway service because the current invocation targets a different Gateway:\n${details}\nRun \`openclaw gateway ${params.action}\` with the installed state directory, config path, and port (or unset conflicting environment overrides). To retarget intentionally, run \`openclaw gateway install --force\`.`,
  );
}

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
  assertGatewayServiceMutationAllowed("repair the gateway service");
  // Repair can persist a generated token; check definition authority before planning it.
  const capability = await params.service
    .readDefinitionMutationCapability?.({ env: process.env, environment: params.state.env })
    .catch(() => ({ kind: "unknown", reason: "inspection-failed" }) as const);
  if (capability) {
    assertServiceDefinitionWritable(capability);
  }
  if (
    hasGatewayServiceLauncherOverride(params.state.command) ||
    hasGatewayServiceEnvironmentDifference(params.state.command, GATEWAY_TARGET_ENV_KEYS)
  ) {
    const unitName = path.basename(params.state.command?.sourcePath ?? "<unit>");
    throw new Error(
      `Refusing to repair the managed Gateway service because a systemd drop-in overrides its command, working directory, or Gateway target environment. Inspect the unit with \`systemctl --user cat ${unitName}\`, then update or remove the operator-owned drop-in before retrying.`,
    );
  }
  const managedCommand = resolveManagedGatewayServiceCommand(params.state.command);
  const { snapshot: configSnapshot, writeOptions: configWriteOptions } =
    await readConfigFileSnapshotForWrite();
  const cfg = configSnapshot.valid ? configSnapshot.sourceConfig : configSnapshot.config;
  const existingEnvironment = managedCommand?.environment;
  const existingEnvironmentValueSources = managedCommand?.environmentValueSources;
  const installedPort = parseTcpPortFromArgs(managedCommand?.programArguments);
  const port = assertGatewayRepairTargetMatches({
    action: params.action ?? "start",
    config: cfg,
    existingEnvironment,
    installedPort,
  });
  const installEnv = mergeInstallInvocationEnv({
    env: process.env,
    existingServiceEnv: existingEnvironment,
  });
  const wrapperPath = await resolveOpenClawWrapperPath(installEnv[OPENCLAW_WRAPPER_ENV_KEY]);
  const installedRuntime = resolveGatewayDaemonRuntime(managedCommand?.programArguments);
  const installedRuntimePath =
    installedRuntime === "bun" ? managedCommand?.programArguments[0] : undefined;
  const runtimeInfo = installedRuntimePath
    ? await resolveBunRuntimeInfo(installedRuntimePath)
    : undefined;
  if (runtimeInfo?.status === "probe-failed") {
    throw runtimeInfo.error;
  }
  const runtime = runtimeInfo?.status === "supported" ? "bun" : "node";

  const tokenResolution = await resolveGatewayInstallToken({
    config: cfg,
    env: installEnv,
    generateIfMissing: { snapshot: configSnapshot, writeOptions: configWriteOptions },
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
      runtime,
      runtimePath: runtime === "bun" ? installedRuntimePath : undefined,
      wrapperPath,
      existingCommand: params.state.command,
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
