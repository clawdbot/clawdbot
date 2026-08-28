/**
 * Gmail Watcher Service
 *
 * Automatically starts `gog gmail watch serve` when the gateway starts,
 * if hooks.gmail is configured with an account.
 */

import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { releaseChildProcessOutputAfterExit } from "../process/child-process.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { killProcessTree } from "../process/kill-tree.js";
import { hasBinary } from "../skills/loading/config.js";
import { ensureTailscaleEndpoint } from "./gmail-setup-utils.js";
import { isAddressInUseError } from "./gmail-watcher-errors.js";
import {
  buildGogWatchServeLogArgs,
  buildGogWatchServeArgs,
  buildGogWatchStartArgs,
  type GmailHookRuntimeConfig,
  resolveGogExecutable,
  resolveGogServeInvocation,
  resolveGmailHookRuntimeConfig,
} from "./gmail.js";

const log = createSubsystemLogger("gmail-watcher");
const GMAIL_WATCHER_STDERR_TAIL_CHARS = 512;

let watcherProcess: ChildProcess | null = null;
let renewInterval: ReturnType<typeof setInterval> | null = null;
let renewalInFlight: Promise<boolean> | null = null;
let renewalAbortController: AbortController | null = null;
let shuttingDown = false;
let currentConfig: GmailHookRuntimeConfig | null = null;
let respawnTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Start the Gmail watch (registers with Gmail API)
 */
async function startGmailWatch(
  cfg: Pick<GmailHookRuntimeConfig, "account" | "label" | "topic">,
  options: { signal?: AbortSignal } = {},
): Promise<boolean> {
  const args = [resolveGogExecutable(), ...buildGogWatchStartArgs(cfg)];
  try {
    const result = await runCommandWithTimeout(args, {
      timeoutMs: 120_000,
      signal: options.signal,
    });
    if (result.code !== 0) {
      const message = result.stderr || result.stdout || "gog watch start failed";
      log.error(`watch start failed: ${message}`);
      return false;
    }
    log.info(`watch started for ${cfg.account}`);
    return true;
  } catch (err) {
    log.error(`watch start error: ${String(err)}`);
    return false;
  }
}

/**
 * Spawn the gog gmail watch serve process
 */
function spawnGogServe(cfg: GmailHookRuntimeConfig): ChildProcess {
  const args = buildGogWatchServeArgs(cfg);
  log.info(`starting gog ${buildGogWatchServeLogArgs(cfg).join(" ")}`);
  let addressInUse = false;
  let spawnFailed = false;
  // Carry a bounded tail so bind markers split across stderr chunks survive until close.
  let stderrTail = "";
  const invocation = resolveGogServeInvocation(args);

  const child = spawn(invocation.command, invocation.args, {
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group on Unix so killProcessTree can reach descendants on shutdown.
    detached: process.platform !== "win32",
    windowsHide: invocation.windowsHide,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });

  child.stdout?.on("error", (err) => {
    log.error(`gog stdout error: ${String(err)}`);
  });
  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      log.info(`[gog] ${line}`);
    }
  });

  child.stderr?.on("error", (err) => {
    log.error(`gog stderr error: ${String(err)}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    const chunk = data.toString();
    // Classify before truncation so a marker completed across the retention boundary survives.
    const combined = stderrTail + chunk;
    if (!addressInUse && isAddressInUseError(combined)) {
      addressInUse = true;
    }
    stderrTail = combined.slice(-GMAIL_WATCHER_STDERR_TAIL_CHARS);
    const line = chunk.trim();
    if (!line) {
      return;
    }
    log.warn(`[gog] ${line}`);
  });

  child.on("error", (err) => {
    // Failed spawn emits close without a pid; later errors on a running child remain retryable.
    if (child.pid === undefined) {
      spawnFailed = true;
    }
    log.error(`gog process error: ${String(err)}`);
  });

  const releaseOutput = releaseChildProcessOutputAfterExit(child);
  child.once("exit", () => {
    // The detached POSIX group remains ours after its leader dies. Windows
    // taskkill requires a live root PID; only bound inherited-pipe drain there.
    if (!shuttingDown && watcherProcess === child && process.platform !== "win32" && child.pid) {
      killProcessTree(child.pid, { force: true, detached: true });
    }
  });

  // `close` follows bounded stdio drain, so late stderr still classifies bind failures.
  child.once("close", (code, signal) => {
    releaseOutput();
    if (shuttingDown || watcherProcess !== child) {
      return;
    }
    if (spawnFailed) {
      watcherProcess = null;
      return;
    }
    if (addressInUse) {
      log.warn(
        "gog serve failed to bind (address already in use); stopping restarts. " +
          "Another watcher is likely running. Set OPENCLAW_SKIP_GMAIL_WATCHER=1 or stop the other process.",
      );
      watcherProcess = null;
      return;
    }
    log.warn(`gog exited (code=${code}, signal=${signal}); restarting in 5s`);
    watcherProcess = null;
    respawnTimeout = setTimeout(() => {
      respawnTimeout = null;
      if (shuttingDown || !currentConfig) {
        return;
      }
      watcherProcess = spawnGogServe(currentConfig);
    }, 5000);
  });

  return child;
}

/**
 * Signal the gog process tree to exit gracefully (SIGTERM, SIGKILL after 3 s)
 * and resolve on exit/close/error or a final 8 s safety timeout.
 */
function settleProcess(proc: ChildProcess): Promise<void> {
  // A Windows root PID can be reused after exit, even while inherited pipes
  // delay close. The spawn owner's bounded drain releases those pipes safely.
  if (process.platform === "win32" && (proc.exitCode != null || proc.signalCode != null)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    let processSettled = false;
    let graceElapsed = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
      if (finalTimeout) {
        clearTimeout(finalTimeout);
      }
      proc.removeListener("exit", settleAfterEscalation);
      proc.removeListener("close", settleAfterEscalation);
      proc.removeListener("error", settleAfterEscalation);
      resolve();
    };
    const settleAfterEscalation = () => {
      processSettled = true;
      if (graceElapsed) {
        settle();
      }
    };
    const finalTimeout = setTimeout(() => {
      if (!settled) {
        log.warn("gog process did not exit after SIGKILL; giving up");
        settle();
      }
    }, 8_000);

    proc.on("exit", settleAfterEscalation);
    proc.on("close", settleAfterEscalation);
    proc.on("error", settleAfterEscalation);

    // killProcessTree sends SIGTERM to the process group (Unix) or uses taskkill /T
    // (Windows) and escalates to SIGKILL after graceMs, reaching any descendants
    // spawned by gog that plain proc.kill() would miss.
    if (typeof proc.pid === "number") {
      const graceMs = 3_000;
      killProcessTree(proc.pid, {
        graceMs,
        detached: process.platform !== "win32",
      });
      // killProcessTree owns escalation but intentionally unrefs its timer.
      // Keep shutdown referenced until that escalation has had a chance to run.
      graceTimer = setTimeout(() => {
        graceElapsed = true;
        if (processSettled) {
          settle();
        }
      }, graceMs + 25);
    } else {
      // pid absent means spawn never started; direct kill clears any lingering state.
      try {
        proc.kill("SIGTERM");
      } catch {
        /* process may not exist */
      }
      graceElapsed = true;
    }
  });
}

async function stopPeriodicRenewal(): Promise<void> {
  if (renewInterval) {
    clearInterval(renewInterval);
    renewInterval = null;
  }

  const renewal = renewalInFlight;
  const controller = renewalAbortController;
  if (!renewal) {
    renewalAbortController = null;
    return;
  }

  controller?.abort();
  await renewal;
  if (renewalInFlight === renewal) {
    renewalInFlight = null;
  }
  if (renewalAbortController === controller) {
    renewalAbortController = null;
  }
}

type GmailWatcherStartResult = {
  started: boolean;
  reason?: string;
};

type GmailWatcherStartOptions = {
  signal?: AbortSignal;
};

function cancelledGmailWatcherStart(
  expectedConfig: GmailHookRuntimeConfig,
): GmailWatcherStartResult {
  if (currentConfig === expectedConfig) {
    currentConfig = null;
  }
  return { started: false, reason: "startup cancelled" };
}

/**
 * Start the Gmail watcher service.
 * Called automatically by the gateway if hooks.gmail is configured.
 */
export async function startGmailWatcher(
  cfg: OpenClawConfig,
  options: GmailWatcherStartOptions = {},
): Promise<GmailWatcherStartResult> {
  // Check if gmail hooks are configured
  if (!cfg.hooks?.enabled) {
    return { started: false, reason: "hooks not enabled" };
  }

  if (!cfg.hooks?.gmail?.account) {
    return { started: false, reason: "no gmail account configured" };
  }

  // Check if gog is available
  if (!hasBinary("gog")) {
    return { started: false, reason: "gog binary not found" };
  }

  // Resolve the full runtime config
  const resolved = resolveGmailHookRuntimeConfig(cfg, {});
  if (!resolved.ok) {
    return { started: false, reason: resolved.error };
  }

  return startGmailWatcherService(resolved.value, options);
}

/** Start the shared watcher lifecycle after the caller resolves config and prerequisites. */
export async function startGmailWatcherService(
  runtimeConfig: GmailHookRuntimeConfig,
  options: GmailWatcherStartOptions = {},
): Promise<GmailWatcherStartResult> {
  if (options.signal?.aborted) {
    return cancelledGmailWatcherStart(runtimeConfig);
  }
  currentConfig = runtimeConfig;

  // Stop any existing watcher before doing async setup so a re-entry
  // does not orphan the old serve process or leave a dangling timer.
  // This must run before Tailscale/watch-start to prevent the old
  // process from exiting and queuing a respawn during async work.
  if (watcherProcess || renewInterval || renewalInFlight || respawnTimeout) {
    shuttingDown = true;
    if (respawnTimeout) {
      clearTimeout(respawnTimeout);
      respawnTimeout = null;
    }
    await stopPeriodicRenewal();
    if (watcherProcess) {
      const oldProcess = watcherProcess;
      watcherProcess = null;
      await settleProcess(oldProcess);
    }
    shuttingDown = false;
  }

  // Set up Tailscale endpoint if needed
  if (runtimeConfig.tailscale.mode !== "off") {
    try {
      await ensureTailscaleEndpoint({
        mode: runtimeConfig.tailscale.mode,
        path: runtimeConfig.tailscale.path,
        port: runtimeConfig.serve.port,
        signal: options.signal,
        target: runtimeConfig.tailscale.target,
      });
      log.info(
        `tailscale ${runtimeConfig.tailscale.mode} configured for port ${runtimeConfig.serve.port}`,
      );
      if (options.signal?.aborted) {
        return cancelledGmailWatcherStart(runtimeConfig);
      }
    } catch (err) {
      if (options.signal?.aborted) {
        return cancelledGmailWatcherStart(runtimeConfig);
      }
      log.error(`tailscale setup failed: ${String(err)}`);
      return {
        started: false,
        reason: `tailscale setup failed: ${String(err)}`,
      };
    }
  }

  // Start the Gmail watch (register with Gmail API)
  const watchStarted = await startGmailWatch(runtimeConfig, { signal: options.signal });
  if (options.signal?.aborted) {
    return cancelledGmailWatcherStart(runtimeConfig);
  }
  if (!watchStarted) {
    log.warn("gmail watch start failed, but continuing with serve");
  }

  // Spawn the gog serve process
  shuttingDown = false;
  watcherProcess = spawnGogServe(runtimeConfig);
  const renewMs = runtimeConfig.renewEveryMinutes * 60_000;
  renewInterval = setInterval(() => {
    if (shuttingDown || renewalInFlight) {
      return;
    }
    const controller = new AbortController();
    renewalAbortController = controller;
    const renewal = startGmailWatch(runtimeConfig, { signal: controller.signal }).finally(() => {
      if (renewalInFlight === renewal) {
        renewalInFlight = null;
      }
      if (renewalAbortController === controller) {
        renewalAbortController = null;
      }
    });
    renewalInFlight = renewal;
  }, renewMs);

  log.info(
    `gmail watcher started for ${runtimeConfig.account} (renew every ${runtimeConfig.renewEveryMinutes}m)`,
  );

  return { started: true };
}

/**
 * Stop the Gmail watcher service.
 */
export async function stopGmailWatcher(): Promise<void> {
  shuttingDown = true;

  if (respawnTimeout) {
    clearTimeout(respawnTimeout);
    respawnTimeout = null;
  }
  await stopPeriodicRenewal();

  if (watcherProcess) {
    log.info("stopping gmail watcher");
    const proc = watcherProcess;
    watcherProcess = null;
    await settleProcess(proc);
  }

  currentConfig = null;
  log.info("gmail watcher stopped");
}
