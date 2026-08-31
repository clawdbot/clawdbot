/** Platform service registry and shared gateway service start/repair logic. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { assertGatewayServiceMutationAllowed } from "../infra/gateway-supervision.js";
import { parseTcpPort, parseTcpPortFromArgs } from "../infra/tcp-port.js";
import { assertFutureConfigActionAllowed } from "./future-config-guard.js";
import {
  installLaunchAgent,
  isLaunchAgentEnabled,
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
import { resolveServiceEntrypoint } from "./service-layout.js";
import {
  createServiceRuntimeInspectionFailure,
  type GatewayServiceRuntime,
} from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceLoadState,
  GatewayServiceManageArgs,
  GatewayServiceReadOptions,
  GatewayServiceRestartResult,
  GatewayServiceStartRepairIssue,
  GatewayServiceStartResult,
  GatewayServiceStageArgs,
  GatewayServiceState,
} from "./service-types.js";
import { readSystemdDefinitionMutationCapability } from "./systemd-definition-mutation.js";
import {
  findInstalledSystemdGatewayScope,
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
  isEnabled?: (args: GatewayServiceEnvArgs) => Promise<boolean>;
  hasInstalledDefinition?: (args: GatewayServiceEnvArgs) => Promise<boolean>;
  readDefinitionMutationCapability?: (
    args: GatewayServiceEnvArgs & { environment?: GatewayServiceEnv },
  ) => ReturnType<typeof readSystemdDefinitionMutationCapability>;
  readCommand: (
    env: GatewayServiceEnv,
    opts?: GatewayServiceReadOptions,
  ) => Promise<GatewayServiceCommandConfig | null>;
  readRuntime: (
    env: GatewayServiceEnv,
    opts?: GatewayServiceReadOptions,
  ) => Promise<GatewayServiceRuntime>;
};

type ReadGatewayServiceStateArgs = GatewayServiceEnvArgs & {
  requireEffective?: boolean;
  validateEnvBeforeStatusRead?: (env: GatewayServiceEnv) => void;
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
  if (state.loadState.status !== "loaded" || !command) {
    return [];
  }
  const issues: GatewayServiceStartRepairIssue[] = [];
  const servicePort =
    parseTcpPortFromArgs(command.programArguments) ??
    parseTcpPort(command.environment?.OPENCLAW_GATEWAY_PORT ?? "");
  if (expectedPort !== undefined && servicePort !== null && servicePort !== expectedPort) {
    issues.push({
      code: "port-mismatch",
      message: `service port ${servicePort} does not match current gateway config port ${expectedPort}`,
    });
  }
  for (const candidate of new Set([
    command.programArguments[0],
    resolveServiceEntrypoint(command),
  ])) {
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
  return { state, issues: collectGatewayServiceStartRepairIssues(state, expectedPort) };
}

export function formatGatewayServiceStartRepairIssues(
  issues: GatewayServiceStartRepairIssue[],
): string {
  return issues.map((issue) => issue.message).join("; ");
}

export async function readGatewayServiceLoadState(
  service: GatewayService,
  args: GatewayServiceEnvArgs = {},
): Promise<GatewayServiceLoadState> {
  try {
    return { status: (await service.isLoaded(args)) ? "loaded" : "not-loaded" };
  } catch (error) {
    return { status: "unknown", detail: String(error) };
  }
}

export async function readGatewayServiceState(
  service: GatewayService,
  args: ReadGatewayServiceStateArgs = {},
): Promise<GatewayServiceState> {
  const baseEnv = args.env ?? (process.env as GatewayServiceEnv);
  const { timeoutMs } = args;
  const command = args.requireEffective
    ? await service.readCommand(baseEnv, { timeoutMs, requireEffective: true })
    : await service.readCommand(baseEnv, { timeoutMs }).catch(() => null);
  const env = mergeGatewayServiceEnv(baseEnv, command);
  // Reject persisted selector drift before invoking the native service manager.
  args.validateEnvBeforeStatusRead?.(env);
  const [installed, loadState, runtime, definitionMutationCapability] = await Promise.all([
    command !== null
      ? true
      : (service.hasInstalledDefinition?.({ env, timeoutMs }).catch(() => false) ?? false),
    readGatewayServiceLoadState(service, { env, timeoutMs }),
    service
      .readRuntime(env, { timeoutMs })
      .catch((error: unknown) => createServiceRuntimeInspectionFailure(error)),
    // Update policy needs definition authority; ordinary status/start reads do not.
    args.requireEffective
      ? service
          .readDefinitionMutationCapability?.({ env: baseEnv, environment: env, timeoutMs })
          .catch(() => ({ kind: "unknown", reason: "inspection-failed" }) as const)
      : undefined,
  ]);
  return {
    installed,
    loadState,
    running: runtime?.status === "running",
    env,
    command,
    ...(definitionMutationCapability ? { definitionMutationCapability } : {}),
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
  if (state.loadState.status === "unknown") {
    throw new Error(`Service status inspection failed: ${state.loadState.detail}`);
  }
  if (state.loadState.status === "not-loaded" && !state.installed) {
    return {
      outcome: "missing-install",
      state,
    };
  }

  if (state.loadState.status === "loaded" && state.running) {
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

  let nextState: GatewayServiceState;
  try {
    await service.start({ ...args, env: state.env });
    nextState = await readGatewayServiceState(service, { env: state.env });
  } catch (err) {
    const recoveryState = await readGatewayServiceState(service, { env: state.env });
    if (!recoveryState.installed) {
      return {
        outcome: "missing-install",
        state: recoveryState,
      };
    }
    throw err;
  }

  if (nextState.loadState.status === "unknown") {
    throw new Error(`Service status inspection failed after start: ${nextState.loadState.detail}`);
  }
  const runtime = nextState.runtime;
  const failedState = normalizeLowercaseStringOrEmpty(runtime?.state) === "failed";
  const newFailedExit =
    runtime?.status === "stopped" &&
    typeof runtime.lastExitStatus === "number" &&
    runtime.lastExitStatus !== 0 &&
    runtime.lastExitStatus !== state.runtime?.lastExitStatus;
  if (failedState || newFailedExit) {
    const failure = failedState ? "state failed" : `exit ${runtime?.lastExitStatus}`;
    throw new Error(`Service failed to start (${failure}). Check the service logs and retry.`);
  }

  return {
    outcome: "started",
    state: nextState,
  };
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
    isEnabled: isLaunchAgentEnabled,
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
    hasInstalledDefinition: async ({ env }) =>
      (await findInstalledSystemdGatewayScope(env ?? process.env)) !== null,
    readDefinitionMutationCapability: ({ env, environment, timeoutMs }) =>
      readSystemdDefinitionMutationCapability(env ?? process.env, { environment, timeoutMs }),
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

function guardGatewayServiceMutation<TArgs extends { env?: GatewayServiceEnv }, TResult>(
  action: string,
  mutate: (args: TArgs) => Promise<TResult>,
): (args: TArgs) => Promise<TResult> {
  return async (args) => {
    // Mutations must satisfy both lifecycle ownership and durable-config
    // version guards before invoking any platform service manager.
    assertGatewayServiceMutationAllowed(action, process.env);
    if (args.env && args.env !== process.env) {
      assertGatewayServiceMutationAllowed(action, args.env);
    }
    await assertFutureConfigActionAllowed(action);
    return await mutate(args);
  };
}

function withGatewayServiceMutationGuards(service: GatewayService): GatewayService {
  return {
    ...service,
    stage: guardGatewayServiceMutation("rewrite the gateway service", service.stage),
    install: guardGatewayServiceMutation("install or rewrite the gateway service", service.install),
    uninstall: guardGatewayServiceMutation("uninstall the gateway service", service.uninstall),
    start: guardGatewayServiceMutation("start the gateway service", service.start),
    stop: guardGatewayServiceMutation("stop the gateway service", service.stop),
    restart: guardGatewayServiceMutation("restart the gateway service", service.restart),
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
