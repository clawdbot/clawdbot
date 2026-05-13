import type { Writable } from "node:stream";
import { readBestEffortConfig, readConfigFileSnapshot } from "../../config/config.js";
import { resolveFutureConfigActionBlock } from "../../config/future-version-guard.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { resolveIsNixMode } from "../../config/paths.js";
import { checkTokenDrift } from "../../daemon/service-audit.js";
import type { GatewayServiceRestartResult } from "../../daemon/service-types.js";
import type { GatewayServiceStartRepairIssue, GatewayServiceState } from "../../daemon/service.js";
import { describeGatewayServiceRestart, startGatewayService } from "../../daemon/service.js";
import type { GatewayService } from "../../daemon/service.js";
import { renderSystemdUnavailableHints } from "../../daemon/systemd-hints.js";
import { isSystemdUserServiceAvailable } from "../../daemon/systemd.js";
import { isGatewaySecretRefUnavailableError } from "../../gateway/credentials.js";
import {
  clearGatewayRestartIntentSync,
  type GatewayRestartIntent,
  writeGatewayRestartIntentSync,
} from "../../infra/restart.js";
import { isWSL } from "../../infra/wsl.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { formatInvalidConfigRecoveryHint } from "../config-recovery-hints.js";
import { resolveGatewayTokenForDriftCheck } from "./gateway-token-drift.js";
import {
  buildDaemonServiceSnapshot,
  createDaemonActionContext,
  type DaemonActionResponse,
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
  fail: (message: string, hints?: string[]) => void;
};

type ServiceRecoveryResult = {
  result: "started" | "stopped" | "restarted";
  message?: string;
  warnings?: string[];
  loaded?: boolean;
};

type ServiceRecoveryContext = {
  json: boolean;
  stdout: Writable;
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

function emitActionMessage(params: {
  json: boolean;
  emit: ReturnType<typeof createDaemonActionContext>["emit"];
  payload: Omit<DaemonActionResponse, "action">;
}) {
  params.emit(params.payload);
  if (!params.json && params.payload.message) {
    defaultRuntime.log(params.payload.message);
  }
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
  try {
    return await params.service.isLoaded({ env: process.env });
  } catch (err) {
    params.fail(`${params.serviceNoun} service check failed: ${String(err)}`);
    return null;
  }
}

/**
 * Best-effort config validation. Returns a string describing the issues if
 * config exists and is invalid, or null if config is valid/missing/unreadable.
 *
 * Note: This reads the config file snapshot in the current CLI environment.
 * Configs using env vars only available in the service context (launchd/systemd)
 * may produce false positives, but the check is intentionally best-effort —
 * a false positive here is safer than a crash on startup. (#35862)
 */
type ConfigActionPreflightFailure = {
  message: string;
  hints?: string[];
};

async function getConfigActionPreflightFailure(
  action: string,
): Promise<ConfigActionPreflightFailure | null> {
  let snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  try {
    snapshot = await readConfigFileSnapshot();
    if (snapshot.exists && !snapshot.valid) {
      return {
        message:
          snapshot.issues.length > 0
            ? formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }).join("\n")
            : "Unknown validation issue.",
      };
    }
  } catch {
    return null;
  }

  const futureBlock = resolveFutureConfigActionBlock({ action, snapshot });
  if (futureBlock) {
    return {
      message: futureBlock.message,
      hints: futureBlock.hints,
    };
  }

  return null;
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

  let loaded = false;
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

  loaded = false;
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
  onNotLoaded?: (ctx: ServiceRecoveryContext) => Promise<ServiceRecoveryResult | null>;
  repairLoadedService?: (ctx: ServiceStartRepairContext) => Promise<ServiceRecoveryResult | null>;
}) {
  const json = Boolean(params.opts?.json);
  const { stdout, emit, fail } = createDaemonActionContext({ action: "start", json });
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
      const handled = await params.onNotLoaded?.({ json, stdout, fail });
      if (handled) {
        emit({
          ok: true,
          result: handled.result,
          message: handled.message,
          warnings: handled.warnings,
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
    const startResult = await startGatewayService(params.service, { env: process.env, stdout });
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
    if (startResult.outcome === "scheduled") {
      const restartStatus = describeGatewayServiceRestart(params.serviceNoun, {
        outcome: "scheduled",
      });
      emitActionMessage({
        json,
        emit,
        payload: {
          ok: true,
          result: "scheduled",
          message: restartStatus.message,
          service: buildDaemonServiceSnapshot(params.service, startResult.state.loaded),
        },
      });
      return;
    }
    if (startResult.outcome === "repair-required") {
      try {
        const handled = await params.repairLoadedService?.({
          json,
          stdout,
          fail,
          state: startResult.state,
          issues: startResult.issues,
        });
        if (handled) {
          emit({
            ok: true,
            result: handled.result,
            message: handled.message,
            warnings: handled.warnings,
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
    });
  } catch (err) {
    const hints = params.renderStartHints();
    fail(`${params.serviceNoun} start failed: ${String(err)}`, hints);
    return;
  }
}

export async function runServiceStop(params: {
  serviceNoun: string;
  service: GatewayService;
  opts?: DaemonLifecycleOptions;
  onNotLoaded?: (ctx: ServiceRecoveryContext) => Promise<ServiceRecoveryResult | null>;
  stopWhenNotLoaded?: boolean;
}) {
  const json = Boolean(params.opts?.json);
  const { stdout, emit, fail } = createDaemonActionContext({ action: "stop", json });

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
        await params.service.stop({ env: process.env, stdout, disable: params.opts?.disable });
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
    await params.service.stop({ env: process.env, stdout, disable: params.opts?.disable });
  } catch (err) {
    fail(`${params.serviceNoun} stop failed: ${String(err)}`);
    return;
  }

  let stopped = false;
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
  postRestartCheck?: (ctx: RestartPostCheckContext) => Promise<GatewayServiceRestartResult | void>;
  onNotLoaded?: (ctx: ServiceRecoveryContext) => Promise<ServiceRecoveryResult | null>;
}): Promise<boolean> {
  const json = Boolean(params.opts?.json);
  const { stdout, emit, fail } = createDaemonActionContext({ action: "restart", json });
  const warnings: string[] = [];
  const restartIntent = params.opts?.restartIntent;
  let handledRecovery: ServiceRecoveryResult | null = null;
  let recoveredLoadedState: boolean | null = null;
  const emitScheduledRestart = (
    restartStatus: ReturnType<typeof describeGatewayServiceRestart>,
    serviceLoaded: boolean,
  ) => {
    emitActionMessage({
      json,
      emit,
      payload: {
        ok: true,
        result: restartStatus.daemonActionResult,
        message: restartStatus.message,
        service: buildDaemonServiceSnapshot(params.service, serviceLoaded),
        warnings: warnings.length ? warnings : undefined,
      },
    });
    return true;
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
      handledRecovery = (await params.onNotLoaded?.({ json, stdout, fail })) ?? null;
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
    if (loaded) {
      let wroteRestartIntent = false;
      if (params.serviceNoun === "Gateway") {
        const runtime = await params.service.readRuntime(process.env).catch(() => null);
        wroteRestartIntent = writeGatewayRestartIntentSync({
          targetPid: runtime?.pid,
          ...(restartIntent ? { intent: restartIntent } : {}),
        });
      }
      try {
        restartResult = await params.service.restart({ env: process.env, stdout });
      } catch (err) {
        if (wroteRestartIntent) {
          clearGatewayRestartIntentSync();
        }
        throw err;
      }
    }
    let restartStatus = describeGatewayServiceRestart(params.serviceNoun, restartResult);
    if (restartStatus.scheduled) {
      return emitScheduledRestart(restartStatus, loaded || recoveredLoadedState === true);
    }
    if (params.postRestartCheck) {
      const postRestartResult = await params.postRestartCheck({ json, stdout, warnings, fail });
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
      message: handledRecovery?.message,
      service: buildDaemonServiceSnapshot(params.service, restarted),
      warnings: warnings.length ? warnings : undefined,
    });
    if (!json && handledRecovery?.message) {
      defaultRuntime.log(handledRecovery.message);
    }
    return true;
  } catch (err) {
    const hints = params.renderStartHints();
    fail(`${params.serviceNoun} restart failed: ${String(err)}`, hints);
    return false;
  }
}
