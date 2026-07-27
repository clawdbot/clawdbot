/** Platform service registry and shared gateway service start/repair logic. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { assertGatewayServiceMutationAllowed } from "../infra/gateway-supervision.js";
import { parseTcpPort, parseTcpPortFromArgs } from "../infra/tcp-port.js";
import { VERSION } from "../version.js";
import { assertFutureConfigActionAllowed } from "./future-config-guard.js";
import {
  installLaunchAgent,
  isLaunchAgentLoaded,
  readLaunchAgentProgramArguments,
  readLaunchAgentRuntime,
  restartLaunchAgent,
  startLaunchAgent,
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
  startScheduledTask,
  stageScheduledTask,
  stopScheduledTask,
  uninstallScheduledTask,
} from "./schtasks.js";
import { mergeGatewayServiceEnv } from "./service-env-merge.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
  GatewayServiceReadOptions,
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
  startSystemdService,
  stageSystemdService,
  stopSystemdService,
  uninstallSystemdService,
} from "./systemd.js";
export type {
  GatewayServiceCommandConfig,
  GatewayServiceInstallArgs,
  GatewayServiceStartRepairIssue,
  GatewayServiceState,
} from "./service-types.js";

// Platform service adapter used by CLI commands across launchd, systemd, and schtasks.
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
  start: (args: GatewayServiceControlArgs) => Promise<void>;
  stop: (args: GatewayServiceControlArgs) => Promise<void>;
  restart: (args: GatewayServiceControlArgs) => Promise<GatewayServiceRestartResult>;
  isLoaded: (args: GatewayServiceEnvArgs) => Promise<boolean>;
  readCommand: (env: GatewayServiceEnv) => Promise<GatewayServiceCommandConfig | null>;
  readRuntime: (
    env: GatewayServiceEnv,
    opts?: GatewayServiceReadOptions,
  ) => Promise<GatewayServiceRuntime>;
};

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
  expectedPort?: number,
): GatewayServiceStartRepairIssue[] {
  const command = state.command;
  if (!state.loaded || !command) {
    return [];
  }
  const issues: GatewayServiceStartRepairIssue[] = [];
  const serviceVersion = command.environment?.OPENCLAW_SERVICE_VERSION?.trim();
  if (serviceVersion && serviceVersion !== VERSION) {
    // Version drift often means the service points at old package paths; require
    // reinstall/repair before pretending restart succeeded.
    issues.push({
      code: "version-mismatch",
      message: `service was installed by OpenClaw ${serviceVersion}, current CLI is ${VERSION}`,
    });
  }
  const servicePort =
    parseTcpPortFromArgs(command.programArguments) ??
    parseTcpPort(command.environment?.OPENCLAW_GATEWAY_PORT ?? "");
  if (expectedPort !== undefined && servicePort !== null && servicePort !== expectedPort) {
    issues.push({
      code: "port-mismatch",
      message: `service port ${servicePort} does not match current gateway config port ${expectedPort}`,
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

/** Reads the installed service and reports definition drift that must be repaired before launch. */
export async function inspectGatewayServiceStartRepair(
  service: GatewayService,
  args: GatewayServiceEnvArgs,
  expectedPort?: number,
): Promise<{ state: GatewayServiceState; issues: GatewayServiceStartRepairIssue[] }> {
  const state = await readGatewayServiceState(service, args);
  return {
    state,
    issues: collectGatewayServiceStartRepairIssues(state, expectedPort),
  };
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
  // Propagate the status read deadline so a wedged service manager fails soft
  // instead of hanging both probes. readCommand parses local files and needs no
  // bound; isLoaded/readRuntime can spawn service-manager subprocesses.
  const [loaded, runtime] = await Promise.all([
    service.isLoaded({ env, timeoutMs: args.timeoutMs }).catch(() => false),
    service.readRuntime(env, { timeoutMs: args.timeoutMs }).catch(() => undefined),
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
  expectedPort?: number,
): Promise<GatewayServiceStartResult> {
  const { state, issues: repairIssues } = await inspectGatewayServiceStartRepair(
    service,
    { env: args.env },
    expectedPort,
  );
  if (!state.loaded && !state.installed) {
    return {
      outcome: "missing-install",
      state,
    };
  }

  if (state.loaded && state.running) {
    return {
      outcome: "already-running",
      state,
      issues: repairIssues,
    };
  }

  if (repairIssues.length > 0) {
    return {
      outcome: "repair-required",
      state,
      issues: repairIssues,
    };
  }

  try {
    await service.start({ ...args, env: state.env });
    const nextState = await readGatewayServiceState(service, { env: state.env });
    return {
      outcome: "started",
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

function createUnsupportedGatewayServiceError(): Error {
  return new Error(`Gateway service install not supported on ${process.platform}`);
}

async function rejectUnsupportedGatewayService(): Promise<never> {
  throw createUnsupportedGatewayServiceError();
}

function createUnsupportedGatewayService(): GatewayService {
  return {
    label: "Gateway service",
    loadedText: "available",
    notLoadedText: "not installed",
    stage: rejectUnsupportedGatewayService,
    install: rejectUnsupportedGatewayService,
    uninstall: rejectUnsupportedGatewayService,
    start: rejectUnsupportedGatewayService,
    stop: rejectUnsupportedGatewayService,
    restart: rejectUnsupportedGatewayService,
    isLoaded: rejectUnsupportedGatewayService,
    readCommand: async () => null,
    readRuntime: async () => ({
      status: "unknown",
      detail: createUnsupportedGatewayServiceError().message,
    }),
  };
}

const GATEWAY_SERVICE_REGISTRY: Record<SupportedGatewayServicePlatform, GatewayService> = {
  darwin: {
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: ignoreServiceWriteResult(stageLaunchAgent),
    install: ignoreServiceWriteResult(installLaunchAgent),
    uninstall: uninstallLaunchAgent,
    start: startLaunchAgent,
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
    start: startSystemdService,
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
    start: startScheduledTask,
    stop: stopScheduledTask,
    restart: restartScheduledTask,
    isLoaded: isScheduledTaskInstalled,
    readCommand: readScheduledTaskCommand,
    readRuntime: readScheduledTaskRuntime,
  },
};

function assertGatewayServiceMutationOwnedByOpenClaw(
  action: string,
  env?: GatewayServiceEnv,
): void {
  assertGatewayServiceMutationAllowed(action, process.env);
  if (env && env !== process.env) {
    assertGatewayServiceMutationAllowed(action, env);
  }
}

function withGatewayServiceMutationGuards(service: GatewayService): GatewayService {
  return {
    ...service,
    stage: async (args) => {
      // Service mutations rewrite durable launchd/systemd/schtasks files, so
      // block them when config was produced by a newer OpenClaw.
      assertGatewayServiceMutationOwnedByOpenClaw("rewrite the gateway service", args.env);
      await assertFutureConfigActionAllowed("rewrite the gateway service");
      return await service.stage(args);
    },
    install: async (args) => {
      assertGatewayServiceMutationOwnedByOpenClaw(
        "install or rewrite the gateway service",
        args.env,
      );
      await assertFutureConfigActionAllowed("install or rewrite the gateway service");
      return await service.install(args);
    },
    uninstall: async (args) => {
      assertGatewayServiceMutationOwnedByOpenClaw("uninstall the gateway service", args.env);
      await assertFutureConfigActionAllowed("uninstall the gateway service");
      return await service.uninstall(args);
    },
    start: async (args) => {
      assertGatewayServiceMutationOwnedByOpenClaw("start the gateway service", args.env);
      await assertFutureConfigActionAllowed("start the gateway service");
      return await service.start(args);
    },
    stop: async (args) => {
      assertGatewayServiceMutationOwnedByOpenClaw("stop the gateway service", args.env);
      await assertFutureConfigActionAllowed("stop the gateway service");
      return await service.stop(args);
    },
    restart: async (args) => {
      assertGatewayServiceMutationOwnedByOpenClaw("restart the gateway service", args.env);
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
    return withGatewayServiceMutationGuards(GATEWAY_SERVICE_REGISTRY[process.platform]);
  }
  return createUnsupportedGatewayService();
}
