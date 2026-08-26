// Runs the interactive TUI loop and coordinates backend, input, and rendering.
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  Container,
  Loader,
  matchesKey,
  ProcessTerminal,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { classifyGatewayConnectFailure } from "../../packages/gateway-protocol/src/connect-error-details.js";
import type { CommandEntry } from "../../packages/gateway-protocol/src/index.js";
import {
  resolveAgentIdByWorkspacePath,
  resolveDefaultAgentId,
  resolveSessionAgentId,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { normalizeThinkLevel } from "../auto-reply/thinking.shared.js";
import { formatCliCommand } from "../cli/command-format.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveCanonicalMainSessionKey } from "../config/sessions/main-session-key.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { EmbeddedStateSignalProcess } from "../infra/embedded-state-lock.js";
import { resolveExecutableFromPathEnv } from "../infra/executable-path.js";
import type { GatewayLockIdentity, GatewayLockOptions } from "../infra/gateway-lock.js";
import { resolveCurrentOpenClawCliInvocation } from "../infra/openclaw-cli-invocation.js";
import { tryProcessCwd } from "../infra/safe-cwd.js";
import { registerUncaughtExceptionHandler } from "../infra/unhandled-rejections.js";
import { setConsoleSubsystemFilter } from "../logging/console.js";
import { loggingState } from "../logging/state.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  buildWindowsCmdExeCommandLine,
  isWindowsBatchCommand,
  resolveTrustedWindowsCmdExe,
} from "../process/windows-command.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { getSlashCommands, shouldSubmitExactArgumentCompletion } from "./commands.js";
import { ChatLog } from "./components/chat-log.js";
import { CustomEditor } from "./components/custom-editor.js";
import { resolveLocalRunShutdownGraceMs } from "./local-run-shutdown.js";
import { editorTheme, tuiTheme as theme } from "./theme/theme.js";
import { createTuiAuthChildOwner } from "./tui-auth-child.js";
import { createTuiAutocompleteProvider } from "./tui-autocomplete.js";
import type { TuiBackend } from "./tui-backend.js";
import { createCommandHandlers } from "./tui-command-handlers.js";
import { createEventHandlers } from "./tui-event-handlers.js";
import {
  formatTuiErrorMessage,
  formatTuiFooter,
  sanitizeRenderableLine,
} from "./tui-formatters.js";
import {
  buildTuiLastSessionScopeKey,
  createRememberSessionKeyWriter,
  readTuiLastSessionKey,
  resolveRememberedTuiSessionKey,
  writeTuiLastSessionKey,
} from "./tui-last-session.js";
import { createLocalShellRunner } from "./tui-local-shell.js";
import { createOverlayHandlers } from "./tui-overlays.js";
import { createTuiPluginApprovalController } from "./tui-plugin-approvals.js";
import { createSessionActions } from "./tui-session-actions.js";
import { TUI_SESSION_LOOKUP_LIMIT } from "./tui-session-list-policy.js";
import { createTuiRunIdTracker } from "./tui-session-run-coordinator.js";
import {
  createEditorSubmitHandler,
  createSubmitBurstCoalescer,
  shouldEnableWindowsGitBashPasteFallback,
  type TuiSubmitAction,
} from "./tui-submit.js";
import { createTuiTaskSuggestionController } from "./tui-task-suggestions.js";
import type {
  SessionInfo,
  SessionScope,
  TuiHistoryRunOutcome,
  TuiOptions,
  TuiResult,
  TuiStateAccess,
} from "./tui-types.js";
import { buildWaitingStatusMessage, defaultWaitingPhrases } from "./tui-waiting.js";

export { resolveFinalAssistantText } from "./tui-formatters.js";
export type { TuiOptions } from "./tui-types.js";
export {
  createEditorSubmitHandler,
  createSubmitBurstCoalescer,
  shouldEnableWindowsGitBashPasteFallback,
} from "./tui-submit.js";

const OPENAI_CODEX_PROVIDER = "openai";
const CODEX_CLI_LOOKUP_TIMEOUT_MS = 5_000;
const SESSION_SUBSCRIPTION_MAX_ATTEMPTS = 5;
const SESSION_SUBSCRIPTION_RETRY_DELAY_MS = 25;

type RunTuiOptions = TuiOptions & {
  /** Explicit owner for a global session key, which cannot carry an agent prefix itself. */
  agentId?: string;
  backend?: TuiBackend;
  submitBurstWindowMs?: number;
  ctrlCExitWindowMs?: number;
  onSubmitBurstCaptured?: (value: string) => void;
  /** Exact pre-probed remote target for an in-process setup handoff. */
  boundGateway?: {
    url: string;
    token?: string;
    password?: string;
    tlsFingerprint?: string;
  };
  config?: OpenClawConfig;
  title?: string;
};

/** Resolve the absolute path to the `codex` CLI binary, or `null` if not installed. */
export async function resolveCodexCliBin(): Promise<string | null> {
  if (process.platform === "win32") {
    const pathEnv = process.env.PATH ?? process.env.Path ?? "";
    // Prefer npm's runnable PATHEXT launcher, but retain bare-only native installs.
    return (
      resolveExecutableFromPathEnv("codex", pathEnv, process.env, {
        includeExtensionless: false,
      }) ??
      resolveExecutableFromPathEnv("codex", pathEnv, process.env, {
        includeExtensionless: true,
      }) ??
      null
    );
  }
  try {
    const result = await runCommandWithTimeout(["which", "codex"], {
      killSignal: "SIGKILL",
      maxOutputBytes: 64 * 1024,
      timeoutMs: CODEX_CLI_LOOKUP_TIMEOUT_MS,
    });
    if (result.code !== 0 || result.termination !== "exit") {
      return null;
    }
    // `where` on Windows can return multiple matches; use PATH order.
    return result.stdout.trim().split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

export function resolveLocalAuthSpawnInvocation(params: {
  command: string;
  args: string[];
  platform?: NodeJS.Platform;
}): {
  args: string[];
  command: string;
  options: { windowsHide?: true; windowsVerbatimArguments?: true };
} {
  const platform = params.platform ?? process.platform;
  if (!isWindowsBatchCommand(params.command.trim(), platform)) {
    return { command: params.command, args: params.args, options: {} };
  }
  return {
    command: resolveTrustedWindowsCmdExe(platform),
    args: ["/d", "/s", "/c", buildWindowsCmdExeCommandLine(params.command, params.args)],
    options: { windowsHide: true, windowsVerbatimArguments: true },
  };
}

export function resolveTuiLocalAuthCliInvocation(params: {
  provider?: string;
  execArgv?: readonly string[];
}) {
  const provider = params.provider?.trim();
  return resolveCurrentOpenClawCliInvocation(
    ["models", "auth", "login", ...(provider ? ["--provider", provider] : [])],
    {
      execArgv: params.execArgv ?? process.execArgv,
    },
  );
}

export function resolveTuiSessionKey(params: {
  raw?: string;
  sessionScope: SessionScope;
  currentAgentId: string;
  sessionMainKey: string;
}) {
  const trimmed = (params.raw ?? "").trim();
  if (!trimmed) {
    return resolveCanonicalMainSessionKey({
      agentId: params.currentAgentId,
      mainKey: params.sessionMainKey,
      sessionScope: params.sessionScope,
    });
  }
  const parsed = parseAgentSessionKey(trimmed);
  if (parsed?.rest === "global") {
    // Initial agent selection already consumed the explicit owner prefix. TUI operations
    // need the literal sentinel so they carry that owner separately as agentId.
    return "global";
  }
  if (trimmed === "global" || trimmed === "unknown") {
    return trimmed;
  }
  return toAgentStoreSessionKey({
    agentId: params.currentAgentId,
    requestKey: trimmed,
    mainKey: params.sessionMainKey,
  });
}

export function resolveTuiSessionSelection(params: {
  raw?: string;
  cfg: OpenClawConfig;
  sessionScope: SessionScope;
  currentAgentId: string;
  sessionMainKey: string;
}): { key: string; agentId: string } {
  const trimmed = (params.raw ?? "").trim();
  const parsed = parseAgentSessionKey(trimmed);
  const persistedOwner = trimmed
    ? resolvePersistedSessionStoreOwnerForKey(params.cfg, trimmed)
    : undefined;
  const agentId = parsed?.agentId
    ? normalizeAgentId(parsed.agentId)
    : persistedOwner?.kind === "configured"
      ? persistedOwner.agentId
      : trimmed
        ? resolveSessionAgentId({
            config: params.cfg,
            sessionKey: trimmed,
            fallbackAgentId: params.currentAgentId,
          })
        : params.currentAgentId;
  const mainKey = normalizeMainKey(params.sessionMainKey);
  const keepDurableBareKey =
    !parsed &&
    persistedOwner?.kind === "configured" &&
    trimmed !== "global" &&
    trimmed !== "unknown" &&
    trimmed.toLowerCase() !== "main" &&
    trimmed.toLowerCase() !== mainKey;
  return {
    key: keepDurableBareKey
      ? trimmed
      : resolveTuiSessionKey({
          raw: trimmed,
          sessionScope: params.sessionScope,
          currentAgentId: agentId,
          sessionMainKey: params.sessionMainKey,
        }),
    agentId,
  };
}

export function resolveInitialTuiAgentId(params: {
  cfg: OpenClawConfig;
  fallbackAgentId?: string;
  initialSessionInput?: string;
  agentId?: string;
  cwd?: string;
}) {
  const initialSessionInput = (params.initialSessionInput ?? "").trim();
  const explicitAgentId = resolveExplicitInitialTuiAgentId(params);
  if (explicitAgentId) {
    return explicitAgentId;
  }
  const effectiveUnscopedSessionKey = initialSessionInput
    ? initialSessionInput
    : params.cfg.session?.scope === "global"
      ? "global"
      : undefined;
  if (effectiveUnscopedSessionKey) {
    return resolveSessionAgentId({
      config: params.cfg,
      sessionKey: effectiveUnscopedSessionKey,
      fallbackAgentId: params.fallbackAgentId,
    });
  }

  const cwd = params.cwd ?? tryProcessCwd();
  const inferredFromWorkspace = cwd ? resolveAgentIdByWorkspacePath(params.cfg, cwd) : null;
  if (inferredFromWorkspace) {
    return inferredFromWorkspace;
  }

  return normalizeAgentId(
    params.fallbackAgentId ??
      tryResolveLegacyCompatibilityAgentId(params.cfg) ??
      resolveDefaultAgentId(params.cfg, {
        surface: "TUI startup",
        hint: "Pass an agent-scoped --session key.",
      }),
  );
}

function resolveExplicitInitialTuiAgentId(params: {
  initialSessionInput?: string;
  agentId?: string;
}): string | null {
  const parsed = parseAgentSessionKey((params.initialSessionInput ?? "").trim());
  const explicitAgentId = parsed?.agentId ?? params.agentId?.trim();
  return explicitAgentId ? normalizeAgentId(explicitAgentId) : null;
}

export function resolveGatewayDisconnectState(
  input: {
    details?: unknown;
    reason?: string | null;
  } = {},
): {
  connectionStatus: string;
  activityStatus: string;
  remediation?: string;
} {
  if (input.reason === "gateway starting") {
    return {
      connectionStatus: "gateway starting",
      activityStatus: "starting up",
    };
  }
  const failure = classifyGatewayConnectFailure(input);
  const reasonLabel =
    failure.userMessage === "gateway unreachable" ? "closed" : failure.userMessage;
  if (failure.kind === "pairing-required") {
    return {
      connectionStatus: `gateway disconnected: ${reasonLabel}`,
      activityStatus: "device approval needed: preview latest request",
      remediation: failure.remediation,
    };
  }
  if (failure.kind === "rate-limited") {
    return {
      connectionStatus: `gateway disconnected: ${reasonLabel}`,
      activityStatus: "gateway authentication temporarily rate-limited",
      remediation: failure.remediation,
    };
  }
  if (failure.kind === "identity-proxy") {
    return {
      connectionStatus: `gateway disconnected: ${reasonLabel}`,
      activityStatus: "identity-aware proxy rejected connection",
      remediation: failure.remediation,
    };
  }
  return {
    connectionStatus: `gateway disconnected: ${reasonLabel}`,
    activityStatus: failure.remediation ? "gateway authentication needs attention" : "idle",
    remediation: failure.remediation,
  };
}

export function createBackspaceDeduper(params?: { dedupeWindowMs?: number; now?: () => number }) {
  const dedupeWindowMs = Math.max(0, Math.floor(params?.dedupeWindowMs ?? 8));
  const now = params?.now ?? (() => Date.now());
  let previousBackspace: { data: string; at: number } | undefined;

  return (data: string): string => {
    if ((data !== "\x08" && data !== "\x7f") || !matchesKey(data, "backspace")) {
      previousBackspace = undefined;
      return data;
    }
    const at = now();
    // SSH can emit both legacy encodings for one press; matching bytes are real repeats.
    const isDuplicate =
      previousBackspace !== undefined &&
      previousBackspace.data !== data &&
      at - previousBackspace.at <= dedupeWindowMs;
    previousBackspace = isDuplicate ? undefined : { data, at };
    return isDuplicate ? "" : data;
  };
}

export function isIgnorableTuiStopError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { code?: unknown; syscall?: unknown; message?: unknown };
  const code = typeof err.code === "string" ? err.code : "";
  const syscall = typeof err.syscall === "string" ? err.syscall : "";
  const message = typeof err.message === "string" ? err.message : "";
  if (code === "EBADF" && syscall === "setRawMode") {
    return true;
  }
  return /setRawMode/i.test(message) && /EBADF/i.test(message);
}

export function stopTuiSafely(stop: () => void): void {
  try {
    stop();
  } catch (error) {
    if (!isIgnorableTuiStopError(error)) {
      throw error;
    }
  }
}

type TerminalLossEmitter = {
  on(event: "close" | "end", listener: () => void): unknown;
  off(event: "close" | "end", listener: () => void): unknown;
};

export function isTuiTerminalLossError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { code?: unknown; message?: unknown; syscall?: unknown };
  const code = typeof err.code === "string" ? err.code : "";
  const message = typeof err.message === "string" ? err.message : "";
  const syscall = typeof err.syscall === "string" ? err.syscall : "";
  if (code === "EIO" || code === "EPIPE") {
    return true;
  }
  return (
    /\b(EIO|EPIPE)\b/i.test(message) && /\b(read|write|TTY|stdin|stdout)\b/i.test(message + syscall)
  );
}

export function installTuiTerminalLossExitHandler(
  requestExit: () => void,
  targets: { stdin?: TerminalLossEmitter; stdout?: TerminalLossEmitter } = {
    stdin: process.stdin,
    stdout: process.stdout,
  },
): () => void {
  let requested = false;
  const requestOnce = (): void => {
    if (requested) {
      return;
    }
    requested = true;
    requestExit();
  };
  const removeUncaughtExceptionHandler = registerUncaughtExceptionHandler((error) => {
    if (!isTuiTerminalLossError(error)) {
      return false;
    }
    requestOnce();
    return true;
  });
  const onClose = (): void => requestOnce();
  targets.stdin?.on("end", onClose);
  targets.stdin?.on("close", onClose);
  targets.stdout?.on("close", onClose);
  return () => {
    removeUncaughtExceptionHandler();
    targets.stdin?.off("end", onClose);
    targets.stdin?.off("close", onClose);
    targets.stdout?.off("close", onClose);
  };
}

export function createDeferredTuiFinish(): {
  requestFinish: () => void;
  setFinish: (finish: () => void) => void;
  clearFinish: () => void;
} {
  let finishTui: (() => void) | null = null;
  let finishRequested = false;
  return {
    requestFinish: () => {
      const finish = finishTui;
      if (finish) {
        finish();
        return;
      }
      finishRequested = true;
    },
    setFinish: (finish) => {
      finishTui = finish;
      if (finishRequested) {
        finish();
      }
    },
    clearFinish: () => {
      finishTui = null;
    },
  };
}

type DrainableTui = {
  stop: () => void;
  terminal?: {
    drainInput?: (maxMs?: number, idleMs?: number) => Promise<void>;
  };
};

const TUI_SHUTDOWN_DRAIN_MAX_MS = 500;
const TUI_SHUTDOWN_DRAIN_IDLE_MS = 100;
const TUI_SHUTDOWN_HARD_EXIT_MS = 2000;
const TUI_PROCESS_EXIT_AFTER_RETURN_MS = 2000;

type TuiProcessExitTimer = {
  unref?: () => void;
};

type TuiProcessExitTimeout = (callback: () => void, delayMs: number) => TuiProcessExitTimer;

type TuiShutdownTask = () => void | Promise<void>;

export function beginTuiShutdown(params: {
  stopCommandScopes?: TuiShutdownTask;
  stopClient: TuiShutdownTask;
  stopTui: TuiShutdownTask;
  disposeStatus: () => void;
  requestFinish: () => void;
  forceExit: () => void;
  hardExitMs: number;
  keepHardExitArmed?: boolean;
  onError: (error: unknown) => void;
  clearTimeoutFn?: (timer: TuiProcessExitTimer) => void;
  setTimeoutFn?: TuiProcessExitTimeout;
}): TuiProcessExitTimer {
  const hardExit = params.setTimeoutFn
    ? { kind: "custom" as const, timer: params.setTimeoutFn(params.forceExit, params.hardExitMs) }
    : { kind: "native" as const, timer: setTimeout(params.forceExit, params.hardExitMs) };
  const hardExitTimer = hardExit.timer;
  hardExitTimer.unref?.();
  // Stop referenced animations before transport teardown can stall or redraw.
  params.disposeStatus();
  void Promise.resolve()
    .then(async () => {
      const errors: unknown[] = [];
      const runtimeTasks = [params.stopCommandScopes, params.stopClient].map(async (task) =>
        task?.(),
      );
      for (const result of await Promise.allSettled(runtimeTasks)) {
        if (result.status === "rejected") {
          errors.push(result.reason);
        }
      }
      // Terminal ownership must be released even when transport teardown fails.
      try {
        await params.stopTui();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "TUI shutdown failed");
      }
    })
    .finally(() => {
      if (params.keepHardExitArmed !== true) {
        if (params.clearTimeoutFn) {
          params.clearTimeoutFn(hardExitTimer);
        } else if (hardExit.kind === "native") {
          clearTimeout(hardExit.timer);
        }
      }
      params.disposeStatus();
    })
    .catch(params.onError)
    .finally(params.requestFinish);

  // For the standalone command, settled teardown is not proof that runTui
  // returned. Its unref keeps clean exits fast while preserving the deadline.
  return hardExitTimer;
}

export function createTuiSignalHandlers(params: {
  handleCtrlC: () => void;
  requestExit: () => void;
}): {
  sigintHandler: () => void;
  sigtermHandler: () => void;
  sighupHandler: () => void;
} {
  return {
    sigintHandler: params.handleCtrlC,
    sigtermHandler: params.requestExit,
    sighupHandler: params.requestExit,
  };
}

export async function drainAndStopTuiSafely(tui: DrainableTui): Promise<void> {
  if (typeof tui.terminal?.drainInput === "function") {
    try {
      await tui.terminal.drainInput(TUI_SHUTDOWN_DRAIN_MAX_MS, TUI_SHUTDOWN_DRAIN_IDLE_MS);
    } catch {
      // Best-effort only. A failed drain should not skip terminal shutdown.
    }
  }
  stopTuiSafely(() => tui.stop());
}

const TUI_BUSY_ACTIVITY_STATUSES = new Set([
  "sending",
  "waiting",
  "streaming",
  "running",
  "finishing context",
  "starting up",
]);

export function isTuiBusyActivityStatus(status: string): boolean {
  return TUI_BUSY_ACTIVITY_STATUSES.has(status);
}

export function resolveTuiToolsToggleActivityStatus(params: {
  currentStatus: string;
  toolsExpanded: boolean;
}): string {
  const toolsStatus = params.toolsExpanded ? "tools expanded" : "tools collapsed";
  if (isTuiBusyActivityStatus(params.currentStatus)) {
    return params.currentStatus;
  }
  return toolsStatus;
}

export function resolveTuiShutdownHardExitMs(params: { localMode?: boolean } = {}): number {
  return TUI_SHUTDOWN_HARD_EXIT_MS + (params.localMode ? resolveLocalRunShutdownGraceMs() : 0);
}

type ScheduleProcessExitAfterTuiReturnParams = {
  delayMs?: number;
  setTimeoutFn?: TuiProcessExitTimeout;
  exit?: (code?: number) => never | void;
  writeStderr?: (text: string) => void;
};

export function scheduleProcessExitAfterTuiReturn(
  params?: ScheduleProcessExitAfterTuiReturnParams & { setTimeoutFn?: undefined },
): ReturnType<typeof setTimeout>;
export function scheduleProcessExitAfterTuiReturn(
  params: ScheduleProcessExitAfterTuiReturnParams & { setTimeoutFn: TuiProcessExitTimeout },
): TuiProcessExitTimer;
export function scheduleProcessExitAfterTuiReturn(
  params: ScheduleProcessExitAfterTuiReturnParams = {},
): TuiProcessExitTimer {
  const delayMs = Math.max(0, Math.floor(params.delayMs ?? TUI_PROCESS_EXIT_AFTER_RETURN_MS));
  const exit = params.exit ?? ((code?: number) => process.exit(code));
  const writeStderr =
    params.writeStderr ??
    ((text: string) => {
      process.stderr.write(text);
    });
  const onTimeout = () => {
    try {
      writeStderr("openclaw tui forcing process exit after return\n");
    } catch {
      // Best effort only; forced exit must not depend on stderr.
    }
    exit(0);
  };
  const timer = params.setTimeoutFn
    ? params.setTimeoutFn(onTimeout, delayMs)
    : setTimeout(onTimeout, delayMs);
  timer.unref?.();
  return timer;
}

export function cancelProcessExitAfterTuiReturn(timer: ReturnType<typeof setTimeout>): void {
  clearTimeout(timer);
}

type CtrlCAction = "clear" | "warn" | "exit";
type TuiCtrlCAction = CtrlCAction | "force-exit";

export function resolveCtrlCAction(params: {
  hasInput: boolean;
  now: number;
  lastCtrlCAt: number;
  exitWindowMs?: number;
}): { action: CtrlCAction; nextLastCtrlCAt: number } {
  const exitWindowMs = Math.max(1, Math.floor(params.exitWindowMs ?? 1000));
  if (params.hasInput) {
    return {
      action: "clear",
      nextLastCtrlCAt: params.now,
    };
  }
  if (params.now - params.lastCtrlCAt <= exitWindowMs) {
    return {
      action: "exit",
      nextLastCtrlCAt: params.lastCtrlCAt,
    };
  }
  return {
    action: "warn",
    nextLastCtrlCAt: params.now,
  };
}

export function resolveTuiCtrlCAction(params: {
  hasInput: boolean;
  now: number;
  lastCtrlCAt: number;
  exitRequested?: boolean;
  wasDisconnected?: boolean;
  exitWindowMs?: number;
}): { action: TuiCtrlCAction; nextLastCtrlCAt: number } {
  if (params.exitRequested === true) {
    return { action: "force-exit", nextLastCtrlCAt: params.lastCtrlCAt };
  }
  if (params.hasInput) {
    return resolveCtrlCAction(params);
  }
  if (params.wasDisconnected === true) {
    return { action: "exit", nextLastCtrlCAt: params.lastCtrlCAt };
  }
  return resolveCtrlCAction(params);
}

export function createTuiConnectionLineage() {
  let hasConnected = false;
  let wasDisconnected = false;
  return {
    connect: () => {
      const reconnected = wasDisconnected;
      hasConnected = true;
      wasDisconnected = false;
      return reconnected;
    },
    disconnect: () => {
      if (hasConnected) {
        wasDisconnected = true;
      }
    },
    wasDisconnected: () => wasDisconnected,
  };
}

function resolveEmptySessionInfoDefaults(config: OpenClawConfig): SessionInfo {
  return {
    verboseLevel: config.agents?.defaults?.verboseDefault,
  };
}

function formatActiveGatewayTuiRefusal(identity: GatewayLockIdentity): string {
  return `A Gateway is running for this state directory (pid ${identity.pid}, port ${identity.port}). Run without --local to use it, or stop the Gateway first (${formatCliCommand("openclaw gateway stop")}).`;
}

/** Hold canonical state ownership for the complete lifetime of a local TUI. */
export async function withEmbeddedTuiStateLock<T>(
  run: (signal: AbortSignal) => Promise<T>,
  deps: {
    gatewayLockOptions?: GatewayLockOptions;
    process?: EmbeddedStateSignalProcess;
  } = {},
): Promise<T> {
  const { acquireEmbeddedStateLock, createEmbeddedStateSignalBridge } =
    await import("../infra/embedded-state-lock.js");
  const signalBridge = createEmbeddedStateSignalBridge(deps.process ?? process);
  let stateLock: Awaited<ReturnType<typeof acquireEmbeddedStateLock>> | undefined;
  try {
    stateLock = await acquireEmbeddedStateLock({
      options: deps.gatewayLockOptions,
      signal: signalBridge.signal,
      formatActiveGatewayRefusal: formatActiveGatewayTuiRefusal,
    });
    return await run(signalBridge.signal);
  } finally {
    await stateLock?.release();
    signalBridge.dispose();
  }
}

export async function runTui(opts: RunTuiOptions): Promise<TuiResult> {
  if (opts.local === true && opts.backend === undefined) {
    return await withEmbeddedTuiStateLock(async () => await runTuiUnlocked(opts));
  }
  return await runTuiUnlocked(opts);
}

class TuiSessionIdentityState {
  sessionKey = "";
  sessionId: string | null = null;
  readonly generations = new Map<string, number>();
  readonly sessionIds = new Map<string, string>();
  constructor(public agentId: string) {}
  generationKey() {
    return JSON.stringify([this.agentId, this.sessionKey]);
  }
}

async function runTuiUnlocked(opts: RunTuiOptions): Promise<TuiResult> {
  const isLocalMode = opts.local === true || opts.backend !== undefined;
  const config = opts.config ?? getRuntimeConfig({ skipPluginValidation: !isLocalMode });
  const cliInvocation = resolveCurrentOpenClawCliInvocation([]);
  const resolveUsableCwd = () => tryProcessCwd() ?? cliInvocation.cwd;
  const emptySessionInfoDefaults = resolveEmptySessionInfoDefaults(config);
  const initialSessionInput = (opts.session ?? "").trim();
  const sessionScope = (config.session?.scope ?? "per-sender") as SessionScope;
  const sessionMainKey = normalizeMainKey(config.session?.mainKey);
  const configuredDefaultAgentId = tryResolveDefaultAgentId(config);
  const initialAgentId = resolveInitialTuiAgentId({
    cfg: config,
    fallbackAgentId: configuredDefaultAgentId,
    initialSessionInput,
    agentId: opts.agentId,
  });
  const agentDefaultId = configuredDefaultAgentId ?? initialAgentId;
  const agentNames = new Map<string, string>();
  let rememberedSessionApplied = false;
  let connectionGeneration = 0;
  const connectionLineage = createTuiConnectionLineage();
  let remediationShown = false;
  const localRunIds = createTuiRunIdTracker();
  const localBtwRunIds = createTuiRunIdTracker();

  const deliverDefault = opts.deliver ?? false;
  const autoMessage = opts.message?.trim();
  const thinkingLevelOverride = normalizeThinkLevel(opts.thinking);
  let dynamicSlashCommands: CommandEntry[] = [];
  let dynamicSlashCommandsKey: string | null = null;
  let dynamicSlashCommandsInFlightKey: string | null = null;
  let dynamicSlashCommandsRequestId = 0;
  let dynamicSlashCommandsReady = false;
  let dynamicSlashCommandsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let exitRequested = false;
  let exitResult: TuiResult = { exitReason: "exit" };
  const authChild = createTuiAuthChildOwner();
  let statusTimer: NodeJS.Timeout | null = null;
  let statusStartedAt: number | null = null;
  let lastActivityStatus = "idle";
  let invalidateSessionRunOwnership: () => void = () => undefined;
  let notifySessionChanged: () => void = () => undefined;
  let reconcileReconnectRun: (_outcome: TuiHistoryRunOutcome) => void = () => undefined;

  const state: TuiStateAccess & {
    sessionGeneration: number;
    sessionIdentity: TuiSessionIdentityState;
  } = {
    sessionIdentity: new TuiSessionIdentityState(initialAgentId),
    agentDefaultId,
    sessionMainKey,
    sessionScope,
    agents: [],
    get currentAgentId() {
      return this.sessionIdentity.agentId;
    },
    set currentAgentId(value: string) {
      if (this.sessionIdentity.agentId === value) {
        return;
      }
      this.sessionIdentity.agentId = value;
      invalidateSessionRunOwnership();
      notifySessionChanged();
    },
    get currentSessionKey() {
      return this.sessionIdentity.sessionKey;
    },
    set currentSessionKey(value: string) {
      this.sessionIdentity.sessionKey = value;
      notifySessionChanged();
    },
    get currentSessionId() {
      return this.sessionIdentity.sessionId;
    },
    set currentSessionId(value: string | null) {
      if (value) {
        const generationKey = this.sessionIdentity.generationKey();
        const previousSessionId = this.sessionIdentity.sessionIds.get(generationKey);
        // The first ID binds an unresolved selection; reset/replacement owners bump explicitly.
        if (previousSessionId && previousSessionId !== value) {
          this.sessionGeneration += 1;
        }
        this.sessionIdentity.sessionIds.set(generationKey, value);
      }
      this.sessionIdentity.sessionId = value;
    },
    get sessionGeneration() {
      const generationKey = this.sessionIdentity.generationKey();
      return this.sessionIdentity.generations.get(generationKey) ?? 0;
    },
    set sessionGeneration(value: number) {
      const generationKey = this.sessionIdentity.generationKey();
      this.sessionIdentity.generations.set(generationKey, Math.max(this.sessionGeneration, value));
    },
    activeChatRunId: null,
    pendingSubmit: null,
    historyLoaded: false,
    sessionInfo: { ...emptySessionInfoDefaults },
    initialSessionApplied: false,
    isConnected: false,
    autoMessageSent: false,
    toolsExpanded: false,
    showThinking: false,
    connectionStatus: isLocalMode ? "starting local runtime" : "connecting",
    activityStatus: "idle",
    statusTimeout: null,
    lastCtrlCAt: 0,
  };

  let client: TuiBackend;
  if (opts.backend) {
    client = opts.backend;
  } else if (opts.local) {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    client = new EmbeddedTuiBackend();
  } else {
    const { GatewayChatClient } = await import("./gateway-chat.js");
    client = opts.boundGateway
      ? await GatewayChatClient.connectBound({ config, ...opts.boundGateway })
      : await GatewayChatClient.connect({
          url: opts.url,
          token: opts.token,
          password: opts.password,
          tlsFingerprint: opts.tlsFingerprint,
        });
  }
  const previousConsoleSubsystemFilter = isLocalMode
    ? loggingState.consoleSubsystemFilter
      ? [...loggingState.consoleSubsystemFilter]
      : null
    : null;
  if (isLocalMode) {
    setConsoleSubsystemFilter(["__openclaw_tui_quiet__"]);
  }

  const tui = new TuiMainScreen(new ProcessTerminal());
  const dedupeBackspace = createBackspaceDeduper();
  tui.addInputListener((data) => {
    const next = dedupeBackspace(data);
    if (next.length === 0) {
      return { consume: true };
    }
    return { data: next };
  });
  const header = new Text("", 1, 0);
  const statusContainer = new Container();
  const footer = new Text("", 1, 0);
  const chatLog = new ChatLog();
  const connectionNotices: string[] = [];
  const addConnectionNotice = (text: string) => {
    connectionNotices.push(text);
    if (connectionNotices.length > 12) {
      connectionNotices.shift();
    }
    chatLog.addSystem(text, { coalesceConsecutive: true });
  };
  const restoreConnectionNotices = () => {
    for (const notice of connectionNotices) {
      chatLog.addSystem(notice, { coalesceConsecutive: true });
    }
  };
  const editor = new CustomEditor(tui, editorTheme);
  const root = new Container();
  root.addChild(header);
  root.addChild(chatLog);
  root.addChild(statusContainer);
  root.addChild(footer);
  root.addChild(editor);

  const resolveDynamicSlashCommandsKey = () => state.currentAgentId;

  let autocompleteFdPath: string | undefined;
  const applyAutocompleteProvider = () => {
    const dynamicKey = resolveDynamicSlashCommandsKey();
    const slashCommands = getSlashCommands({
      cfg: config,
      local: isLocalMode,
      provider: state.sessionInfo.modelProvider,
      model: state.sessionInfo.model,
      agentRuntime: state.sessionInfo.agentRuntime?.id,
      thinkingLevels: state.sessionInfo.thinkingLevels,
      dynamicCommands: dynamicSlashCommandsKey === dynamicKey ? dynamicSlashCommands : [],
    });
    editor.shouldSubmitAutocomplete = (text) =>
      shouldSubmitExactArgumentCompletion(text, slashCommands);
    editor.setAutocompleteProvider(
      createTuiAutocompleteProvider(slashCommands, resolveUsableCwd(), autocompleteFdPath),
    );
  };

  void import("../agents/utils/tools-manager.js")
    .then(({ ensureTool }) => ensureTool("fd", true))
    .then((fdPath) => {
      if (fdPath) {
        autocompleteFdPath = fdPath;
        applyAutocompleteProvider();
      }
    });

  const clearDynamicSlashCommandsRefreshTimer = () => {
    if (!dynamicSlashCommandsRefreshTimer) {
      return;
    }
    clearTimeout(dynamicSlashCommandsRefreshTimer);
    dynamicSlashCommandsRefreshTimer = null;
  };

  const refreshDynamicSlashCommands = () => {
    clearDynamicSlashCommandsRefreshTimer();
    const key = resolveDynamicSlashCommandsKey();
    if (
      !dynamicSlashCommandsReady ||
      !state.isConnected ||
      !client.listCommands ||
      dynamicSlashCommandsKey === key ||
      dynamicSlashCommandsInFlightKey === key
    ) {
      return;
    }
    dynamicSlashCommandsInFlightKey = key;
    const requestId = ++dynamicSlashCommandsRequestId;
    const agentId = state.currentAgentId;
    void client
      .listCommands({
        agentId,
        scope: "text",
        includeArgs: false,
      })
      .then((commands) => {
        if (
          requestId !== dynamicSlashCommandsRequestId ||
          key !== resolveDynamicSlashCommandsKey()
        ) {
          return;
        }
        dynamicSlashCommands = commands;
        dynamicSlashCommandsKey = key;
        applyAutocompleteProvider();
      })
      .catch(() => undefined)
      .finally(() => {
        if (dynamicSlashCommandsInFlightKey === key) {
          dynamicSlashCommandsInFlightKey = null;
        }
      });
  };

  const scheduleDynamicSlashCommandsRefresh = () => {
    if (
      !dynamicSlashCommandsReady ||
      dynamicSlashCommandsRefreshTimer ||
      dynamicSlashCommandsKey === resolveDynamicSlashCommandsKey()
    ) {
      return;
    }
    dynamicSlashCommandsRefreshTimer = setTimeout(refreshDynamicSlashCommands, 0);
    dynamicSlashCommandsRefreshTimer.unref?.();
  };

  const updateAutocompleteProvider = () => {
    applyAutocompleteProvider();
    scheduleDynamicSlashCommandsRefresh();
  };

  tui.addChild(root);
  tui.setFocus(editor);

  const formatSessionKey = (key: string) => {
    if (key === "global" || key === "unknown") {
      return key;
    }
    const parsed = parseAgentSessionKey(key);
    return parsed?.rest ?? key;
  };

  const formatAgentLabel = (id: string) => {
    const name = agentNames.get(id);
    return name ? `${id} (${name})` : id;
  };

  const resolveSessionSelection = (raw?: string, agentId = state.currentAgentId) => {
    return resolveTuiSessionSelection({
      raw,
      cfg: config,
      sessionScope: state.sessionScope,
      currentAgentId: agentId,
      sessionMainKey: state.sessionMainKey,
    });
  };

  // Initial selection predates controller construction, so it intentionally does not notify.
  state.sessionIdentity.sessionKey = resolveSessionSelection(initialSessionInput).key;

  const buildLastSessionScopeKeyFor = (sessionKey = state.currentSessionKey) => {
    const parsed = parseAgentSessionKey(sessionKey);
    return buildTuiLastSessionScopeKey({
      connectionUrl: client.connection.url,
      agentId: parsed?.agentId ?? state.currentAgentId,
      sessionScope: state.sessionScope,
    });
  };

  const rememberCurrentSessionKey = createRememberSessionKeyWriter({
    buildScopeKey: buildLastSessionScopeKeyFor,
    reportFailure: (message) => {
      chatLog.addSystem(`session memory write failed: ${message}`);
      tui.requestRender();
    },
    write: writeTuiLastSessionKey,
  });

  const restoreRememberedSession = async (expectedConnectionGeneration: number) => {
    if (initialSessionInput || rememberedSessionApplied) {
      return;
    }
    const remembered = await readTuiLastSessionKey({
      scopeKey: buildLastSessionScopeKeyFor(),
    });
    if (expectedConnectionGeneration !== connectionGeneration || exitRequested) {
      return;
    }
    const rememberedSelection = remembered ? resolveSessionSelection(remembered) : null;
    const rememberedKey = rememberedSelection?.key ?? null;
    if (!rememberedKey || rememberedKey === state.currentSessionKey) {
      rememberedSessionApplied = true;
      return;
    }
    const rememberedAgent = rememberedSelection?.agentId;
    if (rememberedAgent && normalizeAgentId(rememberedAgent) !== state.currentAgentId) {
      rememberedSessionApplied = true;
      return;
    }
    const sessions = await client
      .listSessions({
        limit: TUI_SESSION_LOOKUP_LIMIT,
        search: rememberedKey,
        includeGlobal: rememberedKey === "global",
        includeUnknown: false,
        agentId: state.currentAgentId,
      })
      .catch(() => null);
    if (!sessions || expectedConnectionGeneration !== connectionGeneration || exitRequested) {
      return;
    }
    // An abandoned connection must leave restoration eligible for the next handshake.
    rememberedSessionApplied = true;
    const restored = resolveRememberedTuiSessionKey({
      rememberedKey,
      currentAgentId: state.currentAgentId,
      sessions: sessions.sessions,
    });
    if (!restored || restored === state.currentSessionKey) {
      return;
    }
    state.currentSessionKey = restored;
    updateHeader();
    updateFooter();
  };

  const updateHeader = () => {
    const sessionLabel = formatSessionKey(state.currentSessionKey);
    const agentLabel = formatAgentLabel(state.currentAgentId);
    const title = opts.title ?? "openclaw tui";
    const text = `${title} - ${client.connection.url} - agent ${agentLabel} - session ${sessionLabel}`;
    header.setText(theme.header(sanitizeRenderableLine(text)));
  };

  let statusText: Text | null = null;
  let statusLoader: Loader | null = null;

  const formatElapsed = (startMs: number) => {
    const totalSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    if (totalSeconds < 60) {
      return `${totalSeconds}s`;
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  };

  const ensureStatusText = () => {
    if (statusText) {
      return;
    }
    statusContainer.clear();
    statusLoader?.stop();
    statusLoader = null;
    statusText = new Text("", 1, 0);
    statusContainer.addChild(statusText);
  };

  const ensureStatusLoader = () => {
    if (statusLoader) {
      return;
    }
    statusContainer.clear();
    statusText = null;
    statusLoader = new Loader(
      tui,
      (spinner) => theme.accent(spinner),
      (text) => theme.bold(theme.accentSoft(text)),
      "",
    );
    statusContainer.addChild(statusLoader);
  };

  let waitingTick = 0;
  let waitingTimer: NodeJS.Timeout | null = null;
  let waitingPhrase: string | null = null;

  const updateBusyStatusMessage = () => {
    if (!statusLoader || !statusStartedAt) {
      return;
    }
    const elapsed = formatElapsed(statusStartedAt);

    if (state.activityStatus === "waiting") {
      waitingTick++;
      statusLoader.setMessage(
        buildWaitingStatusMessage({
          theme,
          tick: waitingTick,
          elapsed,
          connectionStatus: state.connectionStatus,
          phrases: waitingPhrase ? [waitingPhrase] : undefined,
        }),
      );
      return;
    }

    statusLoader.setMessage(`${state.activityStatus} • ${elapsed} | ${state.connectionStatus}`);
  };

  const startStatusTimer = () => {
    if (statusTimer) {
      return;
    }
    statusTimer = setInterval(() => {
      if (!isTuiBusyActivityStatus(state.activityStatus)) {
        return;
      }
      updateBusyStatusMessage();
    }, 1000);
  };

  const stopStatusTimer = () => {
    if (!statusTimer) {
      return;
    }
    clearInterval(statusTimer);
    statusTimer = null;
  };

  const stopStatusTimeout = () => {
    if (!state.statusTimeout) {
      return;
    }
    clearTimeout(state.statusTimeout);
    state.statusTimeout = null;
  };

  const startWaitingTimer = () => {
    if (waitingTimer) {
      return;
    }

    // Pick a phrase once per waiting session.
    if (!waitingPhrase) {
      const idx = Math.floor(Math.random() * defaultWaitingPhrases.length);
      waitingPhrase = defaultWaitingPhrases[idx] ?? defaultWaitingPhrases[0] ?? "waiting";
    }

    waitingTick = 0;

    waitingTimer = setInterval(() => {
      if (state.activityStatus !== "waiting") {
        return;
      }
      updateBusyStatusMessage();
    }, 120);
  };

  const stopWaitingTimer = () => {
    if (!waitingTimer) {
      return;
    }
    clearInterval(waitingTimer);
    waitingTimer = null;
    waitingPhrase = null;
  };

  const disposeStatus = () => {
    stopStatusTimer();
    stopWaitingTimer();
    stopStatusTimeout();
    clearDynamicSlashCommandsRefreshTimer();
    dynamicSlashCommandsRequestId += 1;
    statusLoader?.stop();
    statusLoader = null;
  };

  const renderStatus = () => {
    const isBusy = isTuiBusyActivityStatus(state.activityStatus);
    if (isBusy) {
      if (!statusStartedAt || lastActivityStatus !== state.activityStatus) {
        statusStartedAt = Date.now();
      }
      ensureStatusLoader();
      if (state.activityStatus === "waiting") {
        stopStatusTimer();
        startWaitingTimer();
      } else {
        stopWaitingTimer();
        startStatusTimer();
      }
      updateBusyStatusMessage();
    } else {
      statusStartedAt = null;
      stopStatusTimer();
      stopWaitingTimer();
      statusLoader?.stop();
      statusLoader = null;
      ensureStatusText();
      const text = state.activityStatus
        ? `${state.connectionStatus} | ${state.activityStatus}`
        : state.connectionStatus;
      statusText?.setText(theme.dim(text));
    }
    lastActivityStatus = state.activityStatus;
  };

  const setConnectionStatus = (text: string, ttlMs?: number) => {
    state.connectionStatus = sanitizeRenderableLine(text);
    renderStatus();
    if (state.statusTimeout) {
      stopStatusTimeout();
    }
    if (ttlMs && ttlMs > 0) {
      state.statusTimeout = setTimeout(() => {
        state.connectionStatus = state.isConnected
          ? isLocalMode
            ? "local ready"
            : "connected"
          : isLocalMode
            ? "local stopped"
            : "disconnected";
        renderStatus();
      }, ttlMs);
    }
  };

  const setActivityStatus = (text: string) => {
    state.activityStatus = text;
    renderStatus();
  };

  const withTuiSuspended = async <T>(work: () => Promise<T>): Promise<T> => {
    await drainAndStopTuiSafely(tui);
    if (isLocalMode) {
      setConsoleSubsystemFilter(previousConsoleSubsystemFilter);
    }
    try {
      return await work();
    } finally {
      if (!exitRequested) {
        if (isLocalMode) {
          setConsoleSubsystemFilter(["__openclaw_tui_quiet__"]);
        }
        tui.start();
        tui.setFocus(editor);
        updateHeader();
        updateFooter();
        tui.requestRender(true);
      }
    }
  };

  const runAuthFlow = isLocalMode
    ? async (params: { provider?: string }) =>
        await withTuiSuspended(async () => {
          const provider = params.provider?.trim() || undefined;

          // Codex owns its auth store; delegate when the CLI is available.
          const codexBin =
            provider === OPENAI_CODEX_PROVIDER ||
            (!provider && state.sessionInfo.modelProvider === OPENAI_CODEX_PROVIDER)
              ? await resolveCodexCliBin()
              : null;

          let command: string;
          let args: string[];
          let cwd: string;
          if (codexBin) {
            command = codexBin;
            args = ["login"];
            cwd = resolveUsableCwd();
          } else {
            const invocation = resolveTuiLocalAuthCliInvocation({ provider });
            ({ command, args, cwd } = invocation);
          }

          const invocation = resolveLocalAuthSpawnInvocation({ command, args });
          return await authChild.spawnAndWait(() =>
            spawn(invocation.command, invocation.args, {
              cwd,
              env: process.env,
              stdio: "inherit",
              ...invocation.options,
            }),
          );
        })
    : undefined;

  const updateFooter = () => {
    const sessionKeyLabel = formatSessionKey(state.currentSessionKey);
    const sessionLabel = state.sessionInfo.displayName
      ? `${sessionKeyLabel} (${state.sessionInfo.displayName})`
      : sessionKeyLabel;
    const agentLabel = formatAgentLabel(state.currentAgentId);
    footer.setText(
      theme.dim(
        formatTuiFooter({
          agentLabel,
          sessionLabel,
          sessionInfo: state.sessionInfo,
          thinkingLevel: thinkingLevelOverride ?? state.sessionInfo.thinkingLevel,
          // Delivery is fixed at launch; session switches and patches cannot change it.
          deliver: deliverDefault,
        }),
      ),
    );
  };

  const { openOverlay, closeOverlay } = createOverlayHandlers(tui, editor);
  const pluginApprovals = createTuiPluginApprovalController({
    client,
    chatLog,
    getAgentId: () => state.currentAgentId,
    getSessionKey: () => state.currentSessionKey,
    openOverlay,
    closeOverlay,
    requestRender: () => tui.requestRender(),
  });
  const btw = {
    showResult: (params: { question: string; text: string; isError?: boolean }) => {
      chatLog.showBtw(params);
    },
    clear: () => {
      chatLog.dismissBtw();
    },
  };

  const initialSessionAgentId = initialSessionInput ? state.currentAgentId : null;
  const sessionActions = createSessionActions({
    client,
    chatLog,
    btw,
    tui,
    opts,
    state,
    agentNames,
    initialSessionInput,
    initialSessionAgentId,
    resolveSessionSelection,
    updateHeader,
    updateFooter,
    updateAutocompleteProvider,
    setActivityStatus,
    invalidateRunOwnership: () => invalidateSessionRunOwnership(),
    clearLocalRunIds: localRunIds.clear,
    rememberSessionKey: rememberCurrentSessionKey,
  });
  const {
    refreshAgents,
    refreshSessionInfo,
    applySessionInfoFromPatch,
    applySessionMutationResult,
    loadHistory: loadHistorySnapshot,
    setSession,
    abortActive,
  } = sessionActions;
  const loadHistory = async (reconcileReconnect = false) => {
    const activeRunAtStart = state.activeChatRunId;
    const result = await loadHistorySnapshot();
    if (result.loaded) {
      // History can adopt a newer run before returning; terminal outcomes
      // still belong only to the unchanged run captured before the request.
      const recoveredRunId =
        result.runOutcome.state === "active" ? result.runOutcome.runId : activeRunAtStart;
      if (reconcileReconnect && recoveredRunId && recoveredRunId === state.activeChatRunId) {
        reconcileReconnectRun(result.runOutcome);
      }
      restoreConnectionNotices();
      tui.requestRender();
    }
    return result;
  };
  const taskSuggestions = createTuiTaskSuggestionController({
    client,
    chatLog,
    getAgentId: () => state.currentAgentId,
    getSessionKey: () => state.currentSessionKey,
    openOverlay,
    closeOverlay,
    requestRender: () => tui.requestRender(),
    onAccepted: setSession,
  });
  notifySessionChanged = () => {
    pluginApprovals.sessionChanged();
    taskSuggestions.sessionChanged();
  };

  const {
    handleChatEvent,
    handleAgentEvent,
    handleBtwEvent,
    handleSessionsChangedEvent,
    handleSessionMessageEvent,
    pauseStreamingWatchdog,
    reconnectStreamingWatchdog,
    consumeCompletedRunForPendingSend,
    isRunObserved,
    reconcileHistoryAfterGap,
    flushPendingHistoryRefreshIfIdle,
    dispose: disposeEventHandlers,
  } = createEventHandlers({
    chatLog,
    btw,
    tui,
    state,
    localMode: isLocalMode,
    setActivityStatus,
    refreshSessionInfo,
    loadHistory,
    noteLocalRunId: localRunIds.note,
    isLocalRunId: localRunIds.has,
    forgetLocalRunId: localRunIds.forget,
    clearLocalRunIds: localRunIds.clear,
    isLocalBtwRunId: localBtwRunIds.has,
    forgetLocalBtwRunId: localBtwRunIds.forget,
    clearLocalBtwRunIds: localBtwRunIds.clear,
  });
  reconcileReconnectRun = reconnectStreamingWatchdog;
  const localShell = createLocalShellRunner({
    chatLog,
    tui,
    openOverlay,
    closeOverlay,
  });
  invalidateSessionRunOwnership = () => {
    disposeEventHandlers();
    state.activeChatRunId = null;
    setActivityStatus("idle");
  };

  const deferredFinish = createDeferredTuiFinish();
  // The backend can own requestExit before the editor/coalescer exists.
  let disposeSubmitBurst = () => {};
  const forceExit = () => {
    try {
      process.stderr.write("openclaw tui forcing exit\n");
    } catch {
      // Best effort only; force exit must not depend on stderr.
    }
    process.exit(130);
  };
  const requestExit = (result?: Partial<TuiResult>) => {
    if (exitRequested) {
      forceExit();
      return;
    }
    exitRequested = true;
    authChild.close();
    // Exit owns the input boundary before transport teardown can race a buffered submit.
    disposeSubmitBurst();
    connectionGeneration += 1;
    exitResult = {
      exitReason: result?.exitReason ?? "exit",
      ...(result?.systemAgentMessage ? { systemAgentMessage: result.systemAgentMessage } : {}),
    };
    disposeEventHandlers();
    pluginApprovals?.dispose();
    taskSuggestions?.dispose();
    beginTuiShutdown({
      stopCommandScopes: () => localShell.shutdown(),
      stopClient: () => client.stop(),
      stopTui: () => drainAndStopTuiSafely(tui),
      disposeStatus,
      requestFinish: deferredFinish.requestFinish,
      forceExit,
      hardExitMs: resolveTuiShutdownHardExitMs({ localMode: isLocalMode }),
      keepHardExitArmed: opts.forceProcessExitOnReturn === true,
      onError: (err) => {
        if (!isTuiTerminalLossError(err)) {
          try {
            process.stderr.write(`openclaw tui shutdown failed: ${formatTuiErrorMessage(err)}\n`);
          } catch {
            // Best effort only; exit must still complete.
          }
        }
      },
    });
  };
  const exitAwareClient = client as TuiBackend & {
    setRequestExitHandler?: (handler: () => void) => void;
  };
  exitAwareClient.setRequestExitHandler?.(() => requestExit());

  const {
    handleCommand,
    sendMessage,
    captureMessageAdmission,
    resolveMessageAdmission,
    reportBlockedMessageSubmit,
    openModelSelector,
    openAgentSelector,
    openSessionSelector,
  } = createCommandHandlers({
    client,
    chatLog,
    tui,
    opts: { ...opts, local: isLocalMode },
    state,
    deliverDefault,
    openOverlay,
    closeOverlay,
    refreshSessionInfo,
    applySessionInfoFromPatch,
    applySessionMutationResult,
    loadHistory,
    setSession,
    refreshAgents,
    abortActive,
    setActivityStatus,
    formatSessionKey,
    noteLocalRunId: localRunIds.note,
    noteLocalBtwRunId: localBtwRunIds.note,
    forgetLocalRunId: localRunIds.forget,
    forgetLocalBtwRunId: localBtwRunIds.forget,
    consumeCompletedRunForPendingSend,
    isRunObserved,
    flushPendingHistoryRefreshIfIdle,
    runAuthFlow,
    requestExit,
  });

  updateAutocompleteProvider();
  const notifySubmitError = (action: TuiSubmitAction, error: unknown) => {
    const message = formatTuiErrorMessage(error);
    chatLog.addSystem(`${action} submit failed: ${message}`);
    tui.requestRender();
  };
  const submitHandler = createEditorSubmitHandler({
    editor,
    handleCommand,
    sendMessage,
    handleBangLine: localShell.runLocalShellLine,
    onSubmitError: notifySubmitError,
    admitMessage: resolveMessageAdmission,
    onBlockedMessageSubmit: reportBlockedMessageSubmit,
  });
  const submitBurst = createSubmitBurstCoalescer({
    submit: submitHandler,
    captureSnapshot: captureMessageAdmission,
    enabled: opts.submitBurstWindowMs !== undefined || shouldEnableWindowsGitBashPasteFallback(),
    burstWindowMs: opts.submitBurstWindowMs,
    onCapture: opts.onSubmitBurstCaptured,
  });
  disposeSubmitBurst = submitBurst.dispose;
  editor.onSubmit = submitBurst;

  editor.onEscape = () => {
    if (chatLog.hasVisibleBtw()) {
      chatLog.dismissBtw();
      tui.requestRender();
      return;
    }
    void abortActive();
  };
  const handleCtrlC = () => {
    const now = Date.now();
    const decision = resolveTuiCtrlCAction({
      hasInput: editor.getText().length > 0,
      now,
      lastCtrlCAt: state.lastCtrlCAt,
      exitRequested,
      wasDisconnected: connectionLineage.wasDisconnected(),
      exitWindowMs: opts.ctrlCExitWindowMs,
    });
    if (decision.action === "force-exit") {
      forceExit();
      return;
    }
    state.lastCtrlCAt = decision.nextLastCtrlCAt;
    if (decision.action === "clear") {
      editor.setText("");
      setActivityStatus("cleared input; press ctrl+c again to exit");
      tui.requestRender();
      return;
    }
    if (decision.action === "exit") {
      requestExit();
      return;
    }
    setActivityStatus("press ctrl+c again to exit");
    tui.requestRender();
  };
  editor.onCtrlC = () => {
    handleCtrlC();
  };
  editor.onCtrlD = () => {
    requestExit();
  };
  editor.onCtrlO = () => {
    state.toolsExpanded = !state.toolsExpanded;
    chatLog.setToolsExpanded(state.toolsExpanded);
    // Ctrl+O is presentation-only; preserve busy activity so the status loader
    // does not disappear before the run lifecycle ends.
    setActivityStatus(
      resolveTuiToolsToggleActivityStatus({
        currentStatus: state.activityStatus,
        toolsExpanded: state.toolsExpanded,
      }),
    );
    tui.requestRender();
  };
  editor.onCtrlL = () => {
    void openModelSelector();
  };
  editor.onCtrlG = () => {
    void openAgentSelector();
  };
  editor.onCtrlP = () => {
    void openSessionSelector();
  };
  editor.onCtrlT = () => {
    state.showThinking = !state.showThinking;
    void loadHistory();
  };

  tui.addInputListener((data) => {
    // A visible overlay owns Enter even while an inline BTW card remains visible.
    if (tui.hasOverlay() || !chatLog.hasVisibleBtw()) {
      return undefined;
    }
    if (editor.getText().length > 0) {
      return undefined;
    }
    if (matchesKey(data, "enter")) {
      chatLog.dismissBtw();
      tui.requestRender();
      return { consume: true };
    }
    return undefined;
  });

  client.onEvent = (evt) => {
    if (exitRequested) {
      return;
    }
    pluginApprovals?.handleEvent(evt.event, evt.payload);
    taskSuggestions?.handleEvent(evt.event, evt.payload);
    if (evt.event === "chat") {
      handleChatEvent(evt.payload);
    }
    if (evt.event === "chat.side_result") {
      handleBtwEvent(evt.payload);
    }
    if (evt.event === "agent") {
      handleAgentEvent(evt.payload);
    }
    if (evt.event === "sessions.changed") {
      handleSessionsChangedEvent(evt.payload);
    }
    if (evt.event === "session.message") {
      handleSessionMessageEvent(evt.payload);
    }
  };

  client.onConnected = () => {
    if (exitRequested) {
      return;
    }
    const connectedGeneration = ++connectionGeneration;
    const ownsConnection = () => connectedGeneration === connectionGeneration && !exitRequested;
    state.isConnected = false;
    remediationShown = false;
    setConnectionStatus("subscribing to session events");
    // A reconnect may already have restored a live run's busy status. Only
    // claim the status line when startup owns it, then release that exact state.
    if (!isTuiBusyActivityStatus(state.activityStatus)) {
      setActivityStatus("starting up");
    }
    void (async () => {
      for (let attempt = 0; attempt < SESSION_SUBSCRIPTION_MAX_ATTEMPTS; attempt += 1) {
        try {
          await client.subscribeSessionEvents?.();
          break;
        } catch (err) {
          if (!ownsConnection()) {
            return;
          }
          if (attempt + 1 === SESSION_SUBSCRIPTION_MAX_ATTEMPTS) {
            chatLog.addSystem(`session event subscribe failed: ${formatTuiErrorMessage(err)}`);
            if (state.activityStatus === "starting up") {
              setActivityStatus("idle");
            }
            setConnectionStatus("session event subscription failed");
            tui.requestRender();
            return;
          }
          // A connected but unsubscribed TUI misses every peer's message. Wait
          // between idempotent retries and abandon this generation on reconnect.
          await delay(SESSION_SUBSCRIPTION_RETRY_DELAY_MS * (attempt + 1));
          if (!ownsConnection()) {
            return;
          }
        }
      }
      if (!ownsConnection()) {
        return;
      }
      const reconnected = connectionLineage.connect();
      if (reconnected) {
        reconnectStreamingWatchdog();
      }
      await refreshAgents();
      if (!ownsConnection()) {
        return;
      }
      await restoreRememberedSession(connectedGeneration);
      if (!ownsConnection()) {
        return;
      }
      updateHeader();
      updateAutocompleteProvider();
      try {
        await pluginApprovals?.refresh();
      } catch (err) {
        if (!ownsConnection()) {
          return;
        }
        chatLog.addSystem(`plugin approval refresh failed: ${formatTuiErrorMessage(err)}`);
      }
      if (!ownsConnection()) {
        return;
      }
      try {
        await taskSuggestions?.refresh();
      } catch (err) {
        if (!ownsConnection()) {
          return;
        }
        chatLog.addSystem(`task suggestion refresh failed: ${formatTuiErrorMessage(err)}`);
      }
      if (!ownsConnection()) {
        return;
      }
      await loadHistory(reconnected);
      if (!ownsConnection()) {
        return;
      }
      state.isConnected = true;
      if (state.activityStatus === "starting up") {
        setActivityStatus("idle");
      }
      if (reconnected) {
        addConnectionNotice("gateway reconnected after transport loss");
      }
      setConnectionStatus(
        isLocalMode ? "local ready" : reconnected ? "gateway reconnected" : "gateway connected",
        4000,
      );
      tui.requestRender();
      dynamicSlashCommandsReady = true;
      scheduleDynamicSlashCommandsRefresh();
      if (!state.autoMessageSent && autoMessage) {
        state.autoMessageSent = true;
        await sendMessage(autoMessage, opts.initialMessageTimeoutMs);
        if (!ownsConnection()) {
          return;
        }
      }
      updateFooter();
      tui.requestRender();
    })().catch((err: unknown) => {
      if (!ownsConnection()) {
        return;
      }
      chatLog.addSystem(`startup failed: ${formatTuiErrorMessage(err)}`);
      if (state.activityStatus === "starting up") {
        setActivityStatus("idle");
      }
      setConnectionStatus("startup failed", 5000);
      tui.requestRender();
    });
  };

  const handleBackendDisconnected = (reason: string, details?: unknown) => {
    if (exitRequested) {
      return;
    }
    connectionGeneration += 1;
    state.isConnected = false;
    connectionLineage.disconnect();
    state.historyLoaded = false;
    dynamicSlashCommands = [];
    dynamicSlashCommandsKey = null;
    dynamicSlashCommandsInFlightKey = null;
    dynamicSlashCommandsReady = false;
    clearDynamicSlashCommandsRefreshTimer();
    dynamicSlashCommandsRequestId += 1;
    updateAutocompleteProvider();
    pauseStreamingWatchdog();
    const disconnectState =
      reason === "gateway starting"
        ? resolveGatewayDisconnectState({ reason, details })
        : isLocalMode
          ? {
              connectionStatus: `local runtime stopped${reason ? `: ${reason}` : ""}`,
              activityStatus: "idle",
              remediation: undefined,
            }
          : resolveGatewayDisconnectState({ reason, details });
    setConnectionStatus(disconnectState.connectionStatus, 5000);
    setActivityStatus(disconnectState.activityStatus);
    if (disconnectState.remediation && !remediationShown) {
      remediationShown = true;
      chatLog.addSystem(disconnectState.remediation);
    }
    updateFooter();
    tui.requestRender();
  };
  client.onConnectError = (error) => {
    const details = "details" in error ? (error as { details?: unknown }).details : undefined;
    handleBackendDisconnected(formatTuiErrorMessage(error), details);
  };
  client.onDisconnected = handleBackendDisconnected;

  client.onGap = (info) => {
    if (exitRequested || !state.isConnected) {
      return;
    }
    setConnectionStatus(`event gap: expected ${info.expected}, got ${info.received}`, 5000);
    addConnectionNotice(`gateway event gap: expected ${info.expected}, got ${info.received}`);
    reconcileHistoryAfterGap();
    void (async () => {
      try {
        await pluginApprovals?.refresh();
      } catch (err) {
        chatLog.addSystem(`plugin approval refresh failed: ${formatTuiErrorMessage(err)}`);
      }
      try {
        await taskSuggestions?.refresh();
      } catch (err) {
        chatLog.addSystem(`task suggestion refresh failed: ${formatTuiErrorMessage(err)}`);
      }
    })();
    tui.requestRender();
  };

  updateHeader();
  setConnectionStatus(isLocalMode ? "starting local runtime" : "connecting");
  updateFooter();
  const { sigintHandler, sigtermHandler, sighupHandler } = createTuiSignalHandlers({
    handleCtrlC,
    requestExit,
  });
  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);
  process.on("SIGHUP", sighupHandler);
  let cleanupTerminalLossHandler: (() => void) | null = installTuiTerminalLossExitHandler(() =>
    requestExit(),
  );
  tui.start();
  client.start();
  await new Promise<void>((resolve) => {
    const finish = () => {
      disposeStatus();
      disposeEventHandlers();
      pluginApprovals?.dispose();
      taskSuggestions?.dispose();
      if (isLocalMode) {
        setConsoleSubsystemFilter(previousConsoleSubsystemFilter);
      }
      cleanupTerminalLossHandler?.();
      cleanupTerminalLossHandler = null;
      process.removeListener("SIGINT", sigintHandler);
      process.removeListener("SIGTERM", sigtermHandler);
      process.removeListener("SIGHUP", sighupHandler);
      process.removeListener("exit", finish);
      deferredFinish.clearFinish();
      resolve();
    };
    process.once("exit", finish);
    deferredFinish.setFinish(finish);
  });
  if (opts.forceProcessExitOnReturn === true) {
    scheduleProcessExitAfterTuiReturn();
  }
  return exitResult;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
