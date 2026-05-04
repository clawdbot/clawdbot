import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { VERSION } from "../version.js";
import { assertFutureConfigActionAllowed } from "./future-config-guard.js";
import {
  installLaunchAgent,
  isLaunchAgentLoaded,
  readLaunchAgentProgramArguments,
  readLaunchAgentRuntime,
  restartLaunchAgent,
  stageLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";
import {
  installScheduledTask,
  isScheduledTaskInstalled,
  readScheduledTaskCommand,
  readScheduledTaskRuntime,
  restartScheduledTask,
  stageScheduledTask,
  stopScheduledTask,
  uninstallScheduledTask,
} from "./schtasks.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
  GatewayServiceRestartResult,
  GatewayServiceStartRepairIssue,
  GatewayServiceStartResult,
  GatewayServiceStageArgs,
  GatewayServiceState,
} from "./service-types.js";
import {
  installSystemdService,
  isSystemdServiceEnabled,
  readSystemdServiceExecStart,
  readSystemdServiceRuntime,
  restartSystemdService,
  stageSystemdService,
  stopSystemdService,
  uninstallSystemdService,
} from "./systemd.js";
export type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
  GatewayServiceRestartResult,
  GatewayServiceStartRepairIssue,
  GatewayServiceStartResult,
  GatewayServiceStageArgs,
  GatewayServiceState,
} from "./service-types.js";

function ignoreServiceWriteResult<TArgs extends GatewayServiceInstallArgs>(
  write: (args: TArgs) => Promise<unknown>,
): (args: TArgs) => Promise<void> {
  return async (args: TArgs) => {
    await write(args);
  };
}

export type GatewayService = {
  label: string;
  loadedText: string;
  notLoadedText: string;
  stage: (args: GatewayServiceStageArgs) => Promise<void>;
  install: (args: GatewayServiceInstallArgs) => Promise<void>;
  uninstall: (args: GatewayServiceManageArgs) => Promise<void>;
  stop: (args: GatewayServiceControlArgs) => Promise<void>;
  restart: (args: GatewayServiceControlArgs) => Promise<GatewayServiceRestartResult>;
  isLoaded: (args: GatewayServiceEnvArgs) => Promise<boolean>;
  readCommand: (env: GatewayServiceEnv) => Promise<GatewayServiceCommandConfig | null>;
  readRuntime: (env: GatewayServiceEnv) => Promise<GatewayServiceRuntime>;
};

function mergeGatewayServiceEnv(
  baseEnv: GatewayServiceEnv,
  command: GatewayServiceCommandConfig | null,
): GatewayServiceEnv {
  if (!command?.environment) {
    return baseEnv;
  }
  return {
    ...baseEnv,
    ...command.environment,
  };
}

const TEMP_PROGRAM_ROOTS = [os.tmpdir(), "/tmp", "/private/tmp", "/var/tmp"].map((entry) =>
  path.resolve(entry),
);

function pathIsSameOrChild(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function isTemporaryProgramPath(value: string | undefined): boolean {
  if (!value || !path.isAbsolute(value)) {
    return false;
  }
  const resolved = path.resolve(value);
  return TEMP_PROGRAM_ROOTS.some((root) => pathIsSameOrChild(resolved, root));
}

function isMissingProgramPath(value: string | undefined): boolean {
  if (!value || !path.isAbsolute(value)) {
    return false;
  }
  return !fs.existsSync(value);
}

function collectGatewayServiceStartRepairIssues(
  state: GatewayServiceState,
): GatewayServiceStartRepairIssue[] {
  const command = state.command;
  if (!state.loaded || !command) {
    return [];
  }
  const issues: GatewayServiceStartRepairIssue[] = [];
  const serviceVersion = command.environment?.OPENCLAW_SERVICE_VERSION?.trim();
  if (serviceVersion && serviceVersion !== VERSION) {
    issues.push({
      code: "version-mismatch",
      message: `service was installed by OpenClaw ${serviceVersion}, current CLI is ${VERSION}`,
    });
  }
  for (const candidate of command.programArguments.slice(0, 2)) {
    if (isTemporaryProgramPath(candidate)) {
      issues.push({
        code: "temporary-program",
        message: `service command points at a temporary path: ${candidate}`,
      });
      continue;
    }
    if (isMissingProgramPath(candidate)) {
      issues.push({
        code: "missing-program",
        message: `service command points at a missing path: ${candidate}`,
      });
    }
  }
  return issues;
}

export function formatGatewayServiceStartRepairIssues(
  issues: GatewayServiceStartRepairIssue[],
): string {
  return issues.map((issue) => issue.message).join("; ");
}

export async function readGatewayServiceState(
  service: GatewayService,
  args: GatewayServiceEnvArgs = {},
): Promise<GatewayServiceState> {
  const baseEnv = args.env ?? (process.env as GatewayServiceEnv);
  const command = await service.readCommand(baseEnv).catch(() => null);
  const env = mergeGatewayServiceEnv(baseEnv, command);
  const [loaded, runtime] = await Promise.all([
    service.isLoaded({ env }).catch(() => false),
    service.readRuntime(env).catch(() => undefined),
  ]);
  return {
    installed: command !== null,
    loaded,
    running: runtime?.status === "running",
    env,
    command,
    runtime,
  };
}

export async function startGatewayService(
  service: GatewayService,
  args: GatewayServiceControlArgs,
): Promise<GatewayServiceStartResult> {
  const state = await readGatewayServiceState(service, { env: args.env });
  if (!state.loaded && !state.installed) {
    return {
      outcome: "missing-install",
      state,
    };
  }

  const repairIssues = collectGatewayServiceStartRepairIssues(state);
  if (repairIssues.length > 0) {
    return {
      outcome: "repair-required",
      state,
      issues: repairIssues,
    };
  }

  try {
    const restartResult = await service.restart({ ...args, env: state.env });
    const nextState = await readGatewayServiceState(service, { env: state.env });
    return {
      outcome: restartResult.outcome === "scheduled" ? "scheduled" : "started",
      state: nextState,
    };
  } catch (err) {
    const nextState = await readGatewayServiceState(service, { env: state.env });
    if (!nextState.installed) {
      return {
        outcome: "missing-install",
        state: nextState,
      };
    }
    throw err;
  }
}

export function describeGatewayServiceRestart(
  serviceNoun: string,
  result: GatewayServiceRestartResult,
): {
  scheduled: boolean;
  daemonActionResult: "restarted" | "scheduled";
  message: string;
  progressMessage: string;
} {
  if (result.outcome === "scheduled") {
    return {
      scheduled: true,
      daemonActionResult: "scheduled",
      message: `restart scheduled, ${normalizeLowercaseStringOrEmpty(serviceNoun)} will restart momentarily`,
      progressMessage: `${serviceNoun} service restart scheduled.`,
    };
  }
  return {
    scheduled: false,
    daemonActionResult: "restarted",
    message: `${serviceNoun} service restarted.`,
    progressMessage: `${serviceNoun} service restarted.`,
  };
}

type SupportedGatewayServicePlatform = "darwin" | "linux" | "win32";

const GATEWAY_SERVICE_REGISTRY: Record<SupportedGatewayServicePlatform, GatewayService> = {
  darwin: {
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: ignoreServiceWriteResult(stageLaunchAgent),
    install: ignoreServiceWriteResult(installLaunchAgent),
    uninstall: uninstallLaunchAgent,
    stop: stopLaunchAgent,
    restart: restartLaunchAgent,
    isLoaded: isLaunchAgentLoaded,
    readCommand: readLaunchAgentProgramArguments,
    readRuntime: readLaunchAgentRuntime,
  },
  linux: {
    label: "systemd user",
    loadedText: "enabled",
    notLoadedText: "disabled",
    stage: ignoreServiceWriteResult(stageSystemdService),
    install: ignoreServiceWriteResult(installSystemdService),
    uninstall: uninstallSystemdService,
    stop: stopSystemdService,
    restart: restartSystemdService,
    isLoaded: isSystemdServiceEnabled,
    readCommand: readSystemdServiceExecStart,
    readRuntime: readSystemdServiceRuntime,
  },
  win32: {
    label: "Scheduled Task",
    loadedText: "registered",
    notLoadedText: "missing",
    stage: ignoreServiceWriteResult(stageScheduledTask),
    install: ignoreServiceWriteResult(installScheduledTask),
    uninstall: uninstallScheduledTask,
    stop: stopScheduledTask,
    restart: restartScheduledTask,
    isLoaded: isScheduledTaskInstalled,
    readCommand: readScheduledTaskCommand,
    readRuntime: readScheduledTaskRuntime,
  },
};

function withFutureConfigGuard(service: GatewayService): GatewayService {
  return {
    ...service,
    stage: async (args) => {
      await assertFutureConfigActionAllowed("rewrite the gateway service");
      return await service.stage(args);
    },
    install: async (args) => {
      await assertFutureConfigActionAllowed("install or rewrite the gateway service");
      return await service.install(args);
    },
    uninstall: async (args) => {
      await assertFutureConfigActionAllowed("uninstall the gateway service");
      return await service.uninstall(args);
    },
    stop: async (args) => {
      await assertFutureConfigActionAllowed("stop the gateway service");
      return await service.stop(args);
    },
    restart: async (args) => {
      await assertFutureConfigActionAllowed("restart the gateway service");
      return await service.restart(args);
    },
  };
}

function isSupportedGatewayServicePlatform(
  platform: NodeJS.Platform,
): platform is SupportedGatewayServicePlatform {
  return Object.hasOwn(GATEWAY_SERVICE_REGISTRY, platform);
}

export function resolveGatewayService(): GatewayService {
  if (isSupportedGatewayServicePlatform(process.platform)) {
    return withFutureConfigGuard(GATEWAY_SERVICE_REGISTRY[process.platform]);
  }
  throw new Error(`Gateway service install not supported on ${process.platform}`);
}
