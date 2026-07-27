// Gateway service lifecycle command core: install, uninstall, start, stop, restart.
import type { Writable } from "node:stream";
import { readBestEffortConfig } from "../../config/config.js";
import { resolveIsNixMode } from "../../config/paths.js";
import { checkTokenDrift } from "../../daemon/service-audit.js";
import type { GatewayServiceRestartResult } from "../../daemon/service-types.js";
import type { GatewayServiceStartRepairIssue, GatewayServiceState } from "../../daemon/service.js";
import {
  describeGatewayServiceRestart,
  inspectGatewayServiceStartRepair,
  startGatewayService,
} from "../../daemon/service.js";
import type { GatewayService } from "../../daemon/service.js";
import { renderSystemdUnavailableHints } from "../../daemon/systemd-hints.js";
import { isSystemdUserServiceAvailable } from "../../daemon/systemd.js";
import { isGatewaySecretRefUnavailableError } from "../../gateway/credentials.js";
import {
  clearGatewayRestartIntentSync,
  type GatewayRestartIntent,
  writeGatewayRestartIntentSync,
} from "../../infra/restart-intent.js";
import { isWSL } from "../../infra/wsl.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { formatInvalidConfigRecoveryHint } from "../config-recovery-hints.js";
import { resolveGatewayTokenForDriftCheck } from "./gateway-token-drift.js";
import {
  appendServiceLifecycleRepairAudit,
  createServiceLifecycleMutationAudit,
} from "./lifecycle-audit.js";
import { getConfigActionPreflightFailure } from "./lifecycle-config-preflight.js";
import {
  buildDaemonServiceSnapshot,
  createDaemonActionContext,
  emitDaemonAlreadyRunning,
  emitDaemonScheduledRestart,
} from "./response.js";
import { filterContainerGenericHints } from "./shared.js";

type DaemonLifecycleOptions = {
  json?: boolean;
  force?: boolean;
  wait?: string;
  restartIntent?: GatewayRestartIntent;
  disable?: boolean;
};

type RestartPostCheckContext = {
  json: boolean;
  stdout: Writable;
  warnings: string[];
  warn?: (message: string) => void;
  fail: (message: string, hints?: string[]) => void;
};

type ServiceRecoveryResult<TResult extends "started" | "stopped" | "restarted"> = {
  result: TResult;
  message?: string;
  warnings?: string[];
  loaded?: boolean;
};

type ServiceRecoveryContext = {
  json: boolean;
  stdout: Writable;
  warn?: (message: string) => void;
  fail: (message: string, hints?: string[]) => void;
};

type ServiceStartRepairContext = ServiceRecoveryContext & {
  state: GatewayServiceState;
  issues: GatewayServiceStartRepairIssue[];
};

async function maybeAugmentSystemdHints(hints: string[]): Promise<string[]> {
  if (process.platform !== "linux") {
    return hints;
  }
  const systemdAvailable = await isSystemdUserServiceAvailable().catch(() => false);
  if (systemdAvailable) {
    return hints;
  }
  return [
    ...hints,
    ...renderSystemdUnavailableHints({ wsl: await isWSL(), kind: "generic_unavailable" }),
  ];
}

function mergeWarnings(
  captured: readonly string[],
  reported?: readonly string[],
): string[] | undefined {
  const combined = [...captured, ...(reported ?? [])];
  return combined.length > 0 ? combined : undefined;
}

async function handleServiceNotLoaded(params: {
  serviceNoun: string;
  service: GatewayService;
  loaded: boolean;
  renderStartHints: () => string[];
  json: boolean;
  emit: ReturnType<typeof createDaemonActionContext>["emit"];
}) {
  const hints = filterContainerGenericHints(
    await maybeAugmentSystemdHints(params.renderStartHints()),
  );
  params.emit({
    ok: true,
    result: "not-loaded",
    message: `${params.serviceNoun} service ${params.service.notLoadedText}.`,
    hints,
    service: buildDaemonServiceSnapshot(params.service, params.loaded),
  });
  if (!params.json) {
    defaultRuntime.log(`${params.serviceNoun} service ${params.service.notLoadedText}.`);
    for (const hint of hints) {
      defaultRuntime.log(`Start with: ${hint}`);
    }
  }
}

async function resolveServiceLoadedOrFail(params: {
  serviceNoun: string;
  service: GatewayService;
  fail: ReturnType<typeof createDaemonActionContext>["fail"];
}): Promise<boolean | null> {
  // Returning null keeps failure emission centralized in the caller's action context.
  try {
    return await params.service.isLoaded({ env: process.env });
  } catch (err) {
    params.fail(`${params.serviceNoun} service check failed: ${String(err)}`);
    return null;
  }
}

export async function runServiceUninstall(params: {
  serviceNoun: string;
  service: GatewayService;
  opts?: DaemonLifecycleOptions;
  stopBeforeUninstall: boolean;
  assertNotLoadedAfterUninstall: boolean;
}) {
  const json = Boolean(params.opts?.json);
  const { stdout, emit, fail } = createDaemonActionContext({ action: "uninstall", json });

  if (resolveIsNixMode(process.env)) {
    fail("Nix mode detected; service uninstall is disabled.");
    return;
  }

  {
    const preflight = await getConfigActionPreflightFailure("uninstall the gateway service");
    if (preflight) {
      fail(`${params.serviceNoun} uninstall blocked: ${preflight.message}`, preflight.hints);
      return;
    }
  }

  let loaded;
  try {
    loaded = await params.service.isLoaded({ env: process.env });
  } catch {
    loaded = false;
  }
  if (loaded && params.stopBeforeUninstall) {
    try {
      await params.service.stop({ env: process.env, stdout });
    } catch {
      // Best-effort stop; final loaded check gates success when enabled.
    }
  }
  try {
    await params.service.uninstall({ env: process.env, stdout });
  } catch (err) {
    fail(`${params.serviceNoun} uninstall failed: ${String(err)}`);
    return;
  }
  try {
    loaded = await params.service.isLoaded({ env: process.env });
  } catch {
    loaded = false;
  }
  if (loaded && params.assertNotLoadedAfterUninstall) {
    fail(`${params.serviceNoun} service still loaded after uninstall.`);
    return;
  }
  emit({
    ok: true,
    result: "uninstalled",
    service: buildDaemonServiceSnapshot(params.service, loaded),
  });
}

export async function runServiceStart(params: {
  serviceNoun: string;
  service: GatewayService;
  renderStartHints: () => string[];
  opts?: DaemonLifecycleOptions;
  onNotLoaded?: (ctx: ServiceRecoveryContext) => Promise<ServiceRecoveryResult<"started"> | null>;
  repairLoadedService?: (
    ctx: ServiceStartRepairContext,
  ) => Promise<ServiceRecoveryResult<"started"> | null>;
  expectedPort?: number;
}) {
  const json = Boolean(params.opts?.json);
  const { stdout, warnings, emit, fail } = createDaemonActionContext({ action: "start", json });
  const warn = json ? (message: string) => warnings.push(message) : undefined;
  const loaded = await resolveServiceLoadedOrFail({
    serviceNoun: params.serviceNoun,
    service: params.service,
    fail,
  });

  if (loaded === null) {
    return;
  }
  // Pre-flight config validation (#35862) — run for both loaded and not-loaded
  // to prevent launching from invalid config in any start path.
  {
    const preflight = await getConfigActionPreflightFailure("start the gateway service");
    if (preflight) {
      fail(
        preflight.hints
          ? `${params.serviceNoun} start blocked: ${preflight.message}`
          : `${params.serviceNoun} aborted: config is invalid.\n${preflight.message}\n${formatInvalidConfigRecoveryHint()}`,
        preflight.hints,
      );
      return;
    }
  }
  if (!loaded) {
    try {
      const handled = await params.onNotLoaded?.({ json, stdout, warn, fail });
      if (handled) {
        emit({
          ok: true,
          result: handled.result,
          message: handled.message,
          warnings: mergeWarnings(warnings, handled.warnings),
          service: buildDaemonServiceSnapshot(params.service, handled.loaded ?? false),
        });
        if (!json && handled.message) {
          defaultRuntime.log(handled.message);
        }
        return;
      }
    } catch (err) {
      const hints = params.renderStartHints();
      fail(`${params.serviceNoun} start failed: ${String(err)}`, hints);
      return;
    }
  }
  try {
    const startResult = await startGatewayService(
      params.service,
      {
        env: process.env,
        stdout,
        warn,
        onMutation: createServiceLifecycleMutationAudit({
          serviceNoun: params.serviceNoun,
          action: "start",
        }),
      },
      params.expectedPort,
    );
    if (startResult.outcome === "missing-install") {
      await handleServiceNotLoaded({
        serviceNoun: params.serviceNoun,
        service: params.service,
        loaded: startResult.state.loaded,
        renderStartHints: params.renderStartHints,
        json,
        emit,
      });
      return;
    }
    if (startResult.outcome === "already-running") {
      if (startResult.issues.length > 0) {
        const warning = `${params.serviceNoun} service already running, but its installed service definition needs repair: ${startResult.issues
          .map((issue) => issue.message)
          .join("; ")}; run \`openclaw gateway restart\` to apply.`;
        warnings.push(warning);
        if (!json) {
          defaultRuntime.log(warning);
        }
      }
      emitDaemonAlreadyRunning({
        serviceNoun: params.serviceNoun,
        service: params.service,
        pid: startResult.state.runtime?.pid,
        json,
        warnings,
        emit,
      });
      return;
    }
    if (startResult.outcome === "repair-required") {
      try {
        const handled = await params.repairLoadedService?.({
          json,
          stdout,
          warn,
          fail,
          state: startResult.state,
          issues: startResult.issues,
        });
        if (handled) {
          appendServiceLifecycleRepairAudit({
            serviceNoun: params.serviceNoun,
            action: "start",
          });
          emit({
            ok: true,
            result: handled.result,
            message: handled.message,
            warnings: mergeWarnings(warnings, handled.warnings),
            service: buildDaemonServiceSnapshot(params.service, handled.loaded ?? true),
          });
          if (!json && handled.message) {
            defaultRuntime.log(handled.message);
          }
          return;
        }
      } catch (err) {
        const hints = params.renderStartHints();
        fail(`${params.serviceNoun} repair failed: ${String(err)}`, hints);
        return;
      }
      fail(
        `${params.serviceNoun} service needs repair before it can start: ${startResult.issues
          .map((issue) => issue.message)
          .join("; ")}`,
        [formatCliCommand("openclaw gateway install --force")],
      );
      return;
    }
    emit({
      ok: true,
      result: "started",
      service: buildDaemonServiceSnapshot(params.service, startResult.state.loaded),
      warnings: warnings.length ? warnings : undefined,
    });
  } catch (err) {
    const hints = params.renderStartHints();
    fail(`${params.serviceNoun} start failed: ${String(err)}`, hints);
  }
}

export async function runServiceStop(params: {
  serviceNoun: string;
  service: GatewayService;
  opts?: DaemonLifecycleOptions;
  onNotLoaded?: (ctx: ServiceRecoveryContext) => Promise<ServiceRecoveryResult<"stopped"> | null>;
  stopWhenNotLoaded?: boolean;
}) {
  const json = Boolean(params.opts?.json);
  const { stdout, emit, fail } = createDaemonActionContext({ action: "stop", json });
  const gatewayStopAudit = createServiceLifecycleMutationAudit({
    serviceNoun: params.serviceNoun,
    action: "stop",
  });

  const loaded = await resolveServiceLoadedOrFail({
    serviceNoun: params.serviceNoun,
    service: params.service,
    fail,
  });
  if (loaded === null) {
    return;
  }
  {
    const preflight = await getConfigActionPreflightFailure("stop the gateway service");
    if (preflight) {
      fail(`${params.serviceNoun} stop blocked: ${preflight.message}`, preflight.hints);
      return;
    }
  }
  if (!loaded) {
    if (params.stopWhenNotLoaded) {
      try {
        await params.service.stop({
          env: process.env,
          stdout,
          disable: params.opts?.disable,
          onMutation: gatewayStopAudit,
        });
      } catch (err) {
        fail(`${params.serviceNoun} stop failed: ${String(err)}`);
        return;
      }
      emit({
        ok: true,
        result: "stopped",
        service: buildDaemonServiceSnapshot(params.service, false),
      });
      return;
    }
    try {
      const handled = await params.onNotLoaded?.({ json, stdout, fail });
      if (handled) {
        emit({
          ok: true,
          result: handled.result,
          message: handled.message,
          warnings: handled.warnings,
          service: buildDaemonServiceSnapshot(params.service, false),
        });
        if (!json && handled.message) {
          defaultRuntime.log(handled.message);
        }
        return;
      }
    } catch (err) {
      fail(`${params.serviceNoun} stop failed: ${String(err)}`);
      return;
    }
    emit({
      ok: true,
      result: "not-loaded",
      message: `${params.serviceNoun} service ${params.service.notLoadedText}.`,
      service: buildDaemonServiceSnapshot(params.service, loaded),
    });
    if (!json) {
      defaultRuntime.log(`${params.serviceNoun} service ${params.service.notLoadedText}.`);
    }
    return;
  }
  try {
    await params.service.stop({
      env: process.env,
      stdout,
      disable: params.opts?.disable,
      onMutation: gatewayStopAudit,
    });
  } catch (err) {
    fail(`${params.serviceNoun} stop failed: ${String(err)}`);
    return;
  }

  let stopped;
  try {
    stopped = await params.service.isLoaded({ env: process.env });
  } catch {
    stopped = false;
  }
  emit({
    ok: true,
    result: "stopped",
    service: buildDaemonServiceSnapshot(params.service, stopped),
  });
}

export async function runServiceRestart(params: {
  serviceNoun: string;
  service: GatewayService;
  renderStartHints: () => string[];
  opts?: DaemonLifecycleOptions;
  checkTokenDrift?: boolean;
  expectedPort?: number;
  repairLoadedService?: (
    ctx: ServiceStartRepairContext,
  ) => Promise<ServiceRecoveryResult<"restarted"> | null>;
  postRestartCheck?: (ctx: RestartPostCheckContext) => Promise<GatewayServiceRestartResult | void>;
  onNotLoaded?: (ctx: ServiceRecoveryContext) => Promise<ServiceRecoveryResult<"restarted"> | null>;
}): Promise<boolean> {
  const json = Boolean(params.opts?.json);
  const { stdout, warnings, emit, fail } = createDaemonActionContext({ action: "restart", json });
  const warn = json ? (message: string) => warnings.push(message) : undefined;
  const restartIntent = params.opts?.restartIntent;
  const gatewayRestartAudit = createServiceLifecycleMutationAudit({
    serviceNoun: params.serviceNoun,
    action: "restart",
  });
  let handledRecovery: ServiceRecoveryResult<"restarted"> | null = null;
  let handledRepair: ServiceRecoveryResult<"restarted"> | null = null;
  let recoveredLoadedState: boolean | null = null;
  let wroteRestartIntent = false;
  const prepareGatewayRestartIntent = async () => {
    if (params.serviceNoun !== "Gateway" || wroteRestartIntent) {
      return;
    }
    const runtime = await params.service.readRuntime(process.env).catch(() => null);
    wroteRestartIntent = writeGatewayRestartIntentSync({
      targetPid: runtime?.pid,
      reason: "gateway.restart",
      ...(restartIntent ? { intent: restartIntent } : {}),
    });
  };
  const clearPreparedRestartIntent = () => {
    if (wroteRestartIntent) {
      clearGatewayRestartIntentSync();
      wroteRestartIntent = false;
    }
  };
  const emitScheduledRestart = (
    restartStatus: ReturnType<typeof describeGatewayServiceRestart>,
    serviceLoaded: boolean,
  ) => {
    return emitDaemonScheduledRestart({
      json,
      emit,
      result: restartStatus.daemonActionResult,
      message: restartStatus.message,
      service: params.service,
      loaded: serviceLoaded,
      warnings,
    });
  };

  const loaded = await resolveServiceLoadedOrFail({
    serviceNoun: params.serviceNoun,
    service: params.service,
    fail,
  });
  if (loaded === null) {
    return false;
  }

  // Pre-flight config validation: check before any restart action (including
  // onNotLoaded which may send SIGUSR1 to an unmanaged process). (#35862)
  {
    const preflight = await getConfigActionPreflightFailure("restart the gateway service");
    if (preflight) {
      fail(
        preflight.hints
          ? `${params.serviceNoun} restart blocked: ${preflight.message}`
          : `${params.serviceNoun} aborted: config is invalid.\n${preflight.message}\n${formatInvalidConfigRecoveryHint()}`,
        preflight.hints,
      );
      return false;
    }
  }

  if (!loaded) {
    try {
      handledRecovery = (await params.onNotLoaded?.({ json, stdout, warn, fail })) ?? null;
    } catch (err) {
      fail(`${params.serviceNoun} restart failed: ${String(err)}`);
      return false;
    }
    if (!handledRecovery) {
      await handleServiceNotLoaded({
        serviceNoun: params.serviceNoun,
        service: params.service,
        loaded,
        renderStartHints: params.renderStartHints,
        json,
        emit,
      });
      return false;
    }
    if (handledRecovery.warnings?.length) {
      warnings.push(...handledRecovery.warnings);
    }
    recoveredLoadedState = handledRecovery.loaded ?? null;
  }

  if (loaded && params.repairLoadedService) {
    try {
      const { state, issues } = await inspectGatewayServiceStartRepair(
        params.service,
        { env: process.env },
        params.expectedPort,
      );
      if (issues.length > 0) {
        await prepareGatewayRestartIntent();
        handledRepair = await params.repairLoadedService({
          json,
          stdout,
          warn,
          fail,
          state,
          issues,
        });
        if (!handledRepair) {
          clearPreparedRestartIntent();
          fail(
            `${params.serviceNoun} service needs repair before restart: ${issues
              .map((issue) => issue.message)
              .join("; ")}`,
            [formatCliCommand("openclaw gateway install --force")],
          );
          return false;
        }
        appendServiceLifecycleRepairAudit({
          serviceNoun: params.serviceNoun,
          action: "restart",
          pid: state.runtime?.pid,
        });
        if (handledRepair.warnings?.length) {
          warnings.push(...handledRepair.warnings);
        }
      }
    } catch (err) {
      clearPreparedRestartIntent();
      const hints = params.renderStartHints();
      fail(`${params.serviceNoun} repair failed: ${String(err)}`, hints);
      return false;
    }
  }

  if (loaded && params.checkTokenDrift) {
    // Check for token drift before restart (service token vs config token)
    try {
      const command = await params.service.readCommand(process.env);
      const serviceToken = command?.environment?.OPENCLAW_GATEWAY_TOKEN;
      const cfg = await readBestEffortConfig();
      const driftEnv = {
        ...process.env,
        ...command?.environment,
      };
      const configToken = await resolveGatewayTokenForDriftCheck({ cfg, env: driftEnv });
      const driftIssue = checkTokenDrift({ serviceToken, configToken });
      if (driftIssue) {
        const warning = driftIssue.detail
          ? `${driftIssue.message} ${driftIssue.detail}`
          : driftIssue.message;
        warnings.push(warning);
        if (!json) {
          defaultRuntime.log(`\n⚠️  ${driftIssue.message}`);
          if (driftIssue.detail) {
            defaultRuntime.log(`   ${driftIssue.detail}\n`);
          }
        }
      }
    } catch (err) {
      if (isGatewaySecretRefUnavailableError(err, "gateway.auth.token")) {
        const warning =
          "Unable to verify gateway token drift: gateway.auth.token SecretRef is configured but unavailable in this command path.";
        warnings.push(warning);
        if (!json) {
          defaultRuntime.log(`\n⚠️  ${warning}\n`);
        }
      }
    }
  }

  try {
    let restartResult: GatewayServiceRestartResult = { outcome: "completed" };
    if (loaded && !handledRepair) {
      await prepareGatewayRestartIntent();
      try {
        restartResult = await params.service.restart({
          env: process.env,
          stdout,
          warn,
          onMutation: gatewayRestartAudit,
        });
      } catch (err) {
        clearPreparedRestartIntent();
        throw err;
      }
    }
    let restartStatus = describeGatewayServiceRestart(params.serviceNoun, restartResult);
    if (restartStatus.scheduled) {
      return emitScheduledRestart(restartStatus, loaded || recoveredLoadedState === true);
    }
    if (params.postRestartCheck) {
      const postRestartResult = await params.postRestartCheck({
        json,
        stdout,
        warnings,
        warn,
        fail,
      });
      if (postRestartResult) {
        restartStatus = describeGatewayServiceRestart(params.serviceNoun, postRestartResult);
        if (restartStatus.scheduled) {
          return emitScheduledRestart(restartStatus, loaded || recoveredLoadedState === true);
        }
      }
    }
    let restarted = loaded;
    if (loaded) {
      try {
        restarted = await params.service.isLoaded({ env: process.env });
      } catch {
        restarted = true;
      }
    } else if (recoveredLoadedState !== null) {
      restarted = recoveredLoadedState;
    }
    emit({
      ok: true,
      result: "restarted",
      message: handledRecovery?.message ?? handledRepair?.message,
      service: buildDaemonServiceSnapshot(params.service, restarted),
      warnings: warnings.length ? warnings : undefined,
    });
    const actionMessage = handledRecovery?.message ?? handledRepair?.message;
    if (!json && actionMessage) {
      defaultRuntime.log(actionMessage);
    }
    return true;
  } catch (err) {
    const hints = params.renderStartHints();
    fail(`${params.serviceNoun} restart failed: ${String(err)}`, hints);
    return false;
  }
}
