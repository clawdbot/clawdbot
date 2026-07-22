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
 * Check if gog binary is available
 */
function isGogAvailable(): boolean {
  return hasBinary("gog");
}

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

  // `close` follows stdio drain, so late stderr participates in restart classification.
  child.on("close", (code, signal) => {
    // If a newer watcher has replaced this child, do not respawn.
    if (watcherProcess !== null && watcherProcess !== child) {
      return;
    }
    if (shuttingDown) {
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
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(finalTimeout);
      resolve();
    };

    proc.on("exit", settle);
    proc.on("close", settle);
    proc.on("error", settle);

    // killProcessTree sends SIGTERM to the process group (Unix) or uses taskkill /T
    // (Windows) and escalates to SIGKILL after graceMs, reaching any descendants
    // spawned by gog that plain proc.kill() would miss.
    if (typeof proc.pid === "number") {
      killProcessTree(proc.pid, {
        graceMs: 3_000,
        detached: process.platform !== "win32",
      });
    } else {
      // pid absent means spawn never started; direct kill clears any lingering state.
      try {
        proc.kill("SIGTERM");
      } catch {
        /* process may not exist */
      }
    }

    const finalTimeout: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (!settled) {
        log.warn("gog process did not exit after SIGKILL; giving up");
        settle();
      }
    }, 8_000);
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

type GmailWatcherCancellation = {
  dispose: () => void;
  isCancelled: () => boolean;
  signal?: AbortSignal;
};

type GmailWatcherStartOptions = {
  isCancelled?: () => boolean;
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

function isGmailWatcherStartCancelled(options: GmailWatcherStartOptions): boolean {
  return options.signal?.aborted === true || options.isCancelled?.() === true;
}

function createGmailWatcherCancellation(
  options: GmailWatcherStartOptions,
): GmailWatcherCancellation {
  if (!options.signal && !options.isCancelled) {
    return {
      dispose: () => {},
      isCancelled: () => false,
    };
  }

  const abortController = new AbortController();
  const abort = () => {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };
  const onAbort = () => abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  let cancelPoll: ReturnType<typeof setInterval> | null = null;
  if (options.isCancelled) {
    cancelPoll = setInterval(() => {
      if (options.isCancelled?.()) {
        abort();
      }
    }, 100);
    cancelPoll.unref?.();
  }

  if (isGmailWatcherStartCancelled(options)) {
    abort();
  }

  return {
    dispose: () => {
      if (cancelPoll) {
        clearInterval(cancelPoll);
        cancelPoll = null;
      }
      options.signal?.removeEventListener("abort", onAbort);
    },
    isCancelled: () => abortController.signal.aborted || isGmailWatcherStartCancelled(options),
    signal: abortController.signal,
  };
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
  const gogAvailable = isGogAvailable();
  if (!gogAvailable) {
    return { started: false, reason: "gog binary not found" };
  }

  // Resolve the full runtime config
  const resolved = resolveGmailHookRuntimeConfig(cfg, {});
  if (!resolved.ok) {
    return { started: false, reason: resolved.error };
  }

  const runtimeConfig = resolved.value;
  if (isGmailWatcherStartCancelled(options)) {
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
      // Remove lingering spawnGogServe listeners so a late exit (after the
      // settleProcess timeout) cannot trigger a duplicate respawn while
      // watcherProcess is null and shuttingDown is false.
      oldProcess.removeAllListeners();
    }
    shuttingDown = false;
  }

  // Set up Tailscale endpoint if needed
  if (runtimeConfig.tailscale.mode !== "off") {
    const cancellation = createGmailWatcherCancellation(options);
    try {
      await ensureTailscaleEndpoint({
        mode: runtimeConfig.tailscale.mode,
        path: runtimeConfig.tailscale.path,
        port: runtimeConfig.serve.port,
        signal: cancellation.signal,
        target: runtimeConfig.tailscale.target,
      });
      log.info(
        `tailscale ${runtimeConfig.tailscale.mode} configured for port ${runtimeConfig.serve.port}`,
      );
      if (cancellation.isCancelled()) {
        return cancelledGmailWatcherStart(runtimeConfig);
      }
    } catch (err) {
      if (cancellation.isCancelled()) {
        return cancelledGmailWatcherStart(runtimeConfig);
      }
      log.error(`tailscale setup failed: ${String(err)}`);
      return {
        started: false,
        reason: `tailscale setup failed: ${String(err)}`,
      };
    } finally {
      cancellation.dispose();
    }
  }

  // Start the Gmail watch (register with Gmail API)
  const cancellation = createGmailWatcherCancellation(options);
  const watchStarted = await startGmailWatch(runtimeConfig, { signal: cancellation.signal });
  cancellation.dispose();
  if (cancellation.isCancelled()) {
    return cancelledGmailWatcherStart(runtimeConfig);
  }
  if (!watchStarted) {
    log.warn("gmail watch start failed, but continuing with serve");
  }

  // Spawn the gog serve process
  if (isGmailWatcherStartCancelled(options)) {
    return cancelledGmailWatcherStart(runtimeConfig);
  }
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
