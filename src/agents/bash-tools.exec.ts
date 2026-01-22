import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

import {
  type ExecAsk,
  type ExecHost,
  type ExecSecurity,
  type ExecApprovalsFile,
  addAllowlistEntry,
  analyzeShellCommand,
  evaluateExecAllowlist,
  maxAsk,
  minSecurity,
  requiresExecApproval,
  resolveSafeBins,
  recordAllowlistUse,
  resolveExecApprovals,
  resolveExecApprovalsFromFile,
} from "../infra/exec-approvals.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import {
  getShellPathFromLoginShell,
  resolveShellEnvFallbackTimeoutMs,
} from "../infra/shell-env.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { logInfo } from "../logger.js";
import {
  type ProcessSession,
  type SessionStdin,
  addSession,
  appendOutput,
  createSessionSlug,
  markBackgrounded,
  markExited,
  tail,
} from "./bash-process-registry.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import {
  buildDockerExecArgs,
  buildSandboxEnv,
  chunkString,
  clampNumber,
  coerceEnv,
  killSession,
  readEnvInt,
  resolveSandboxWorkdir,
  resolveWorkdir,
  truncateMiddle,
} from "./bash-tools.shared.js";
import { callGatewayTool } from "./tools/gateway.js";
import { listNodes, resolveNodeIdFromList } from "./tools/nodes-utils.js";
import { getShellConfig, sanitizeBinaryOutput } from "./shell-utils.js";
import { buildCursorPositionResponse, stripDsrRequests } from "./pty-dsr.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";

const DEFAULT_MAX_OUTPUT = clampNumber(
  readEnvInt("PI_BASH_MAX_OUTPUT_CHARS"),
  200_000,
  1_000,
  200_000,
);
const DEFAULT_PENDING_MAX_OUTPUT = clampNumber(
  readEnvInt("CLAWDBOT_BASH_PENDING_MAX_OUTPUT_CHARS"),
  200_000,
  1_000,
  200_000,
);
const DEFAULT_PATH =
  process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_NOTIFY_TAIL_CHARS = 400;
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS = 130_000;
const DEFAULT_APPROVAL_RUNNING_NOTICE_MS = 10_000;
const APPROVAL_SLUG_LENGTH = 8;

type PtyExitEvent = { exitCode: number; signal?: number };
type PtyListener<T> = (event: T) => void;
type PtyHandle = {
  pid: number;
  write: (data: string | Buffer) => void;
  onData: (listener: PtyListener<string>) => void;
  onExit: (listener: PtyListener<PtyExitEvent>) => void;
};
type PtySpawn = (
  file: string,
  args: string[] | string,
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  },
) => PtyHandle;

type ExecProcessOutcome = {
  status: "completed" | "failed";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  durationMs: number;
  aggregated: string;
  timedOut: boolean;
  reason?: string;
};

type ExecProcessHandle = {
  session: ProcessSession;
  startedAt: number;
  pid?: number;
  promise: Promise<ExecProcessOutcome>;
  kill: () => void;
};

export type ExecToolDefaults = {
  host?: ExecHost;
  security?: ExecSecurity;
  ask?: ExecAsk;
  node?: string;
  pathPrepend?: string[];
  safeBins?: string[];
  agentId?: string;
  backgroundMs?: number;
  timeoutSec?: number;
  approvalRunningNoticeMs?: number;
  sandbox?: BashSandboxConfig;
  elevated?: ExecElevatedDefaults;
  allowBackground?: boolean;
  scopeKey?: string;
  sessionKey?: string;
  messageProvider?: string;
  notifyOnExit?: boolean;
  cwd?: string;
};

export type { BashSandboxConfig } from "./bash-tools.shared.js";

export type ExecElevatedDefaults = {
  enabled: boolean;
  allowed: boolean;
  defaultLevel: "on" | "off" | "ask" | "full";
};

const execSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  workdir: Type.Optional(Type.String({ description: "Working directory (defaults to cwd)" })),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  yieldMs: Type.Optional(
    Type.Number({
      description: "Milliseconds to wait before backgrounding (default 10000)",
    }),
  ),
  background: Type.Optional(Type.Boolean({ description: "Run in background immediately" })),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, kills process on expiry)",
    }),
  ),
  pty: Type.Optional(
    Type.Boolean({
      description:
        "Run in a pseudo-terminal (PTY) when available (TTY-required CLIs, coding agents)",
    }),
  ),
  elevated: Type.Optional(
    Type.Boolean({
      description: "Run on the host with elevated permissions (if allowed)",
    }),
  ),
  host: Type.Optional(
    Type.String({
      description: "Exec host (sandbox|gateway|node).",
    }),
  ),
  security: Type.Optional(
    Type.String({
      description: "Exec security mode (deny|allowlist|full).",
    }),
  ),
  ask: Type.Optional(
    Type.String({
      description: "Exec ask mode (off|on-miss|always).",
    }),
  ),
  node: Type.Optional(
    Type.String({
      description: "Node id/name for host=node.",
    }),
  ),
});

export type ExecToolDetails =
  | {
      status: "running";
      sessionId: string;
      pid?: number;
      startedAt: number;
      cwd?: string;
      tail?: string;
    }
  | {
      status: "completed" | "failed";
      exitCode: number | null;
      durationMs: number;
      aggregated: string;
      cwd?: string;
    }
  | {
      status: "approval-pending";
      approvalId: string;
      approvalSlug: string;
      expiresAtMs: number;
      host: ExecHost;
      command: string;
      cwd?: string;
      nodeId?: string;
    };

function normalizeExecHost(value?: string | null): ExecHost | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "sandbox" || normalized === "gateway" || normalized === "node") {
    return normalized;
  }
  return null;
}

function normalizeExecSecurity(value?: string | null): ExecSecurity | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return null;
}

function normalizeExecAsk(value?: string | null): ExecAsk | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized as ExecAsk;
  }
  return null;
}

function renderExecHostLabel(host: ExecHost) {
  return host === "sandbox" ? "sandbox" : host === "gateway" ? "gateway" : "node";
}

function normalizeNotifyOutput(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizePathPrepend(entries?: string[]) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function mergePathPrepend(existing: string | undefined, prepend: string[]) {
  if (prepend.length === 0) return existing;
  const partsExisting = (existing ?? "")
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const part of [...prepend, ...partsExisting]) {
    if (seen.has(part)) continue;
    seen.add(part);
    merged.push(part);
  }
  return merged.join(path.delimiter);
}

function applyPathPrepend(
  env: Record<string, string>,
  prepend: string[],
  options?: { requireExisting?: boolean },
) {
  if (prepend.length === 0) return;
  if (options?.requireExisting && !env.PATH) return;
  const merged = mergePathPrepend(env.PATH, prepend);
  if (merged) env.PATH = merged;
}

function applyShellPath(env: Record<string, string>, shellPath?: string | null) {
  if (!shellPath) return;
  const entries = shellPath
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  if (entries.length === 0) return;
  const merged = mergePathPrepend(env.PATH, entries);
  if (merged) env.PATH = merged;
}

function maybeNotifyOnExit(session: ProcessSession, status: "completed" | "failed") {
  if (!session.backgrounded || !session.notifyOnExit || session.exitNotified) return;
  const sessionKey = session.sessionKey?.trim();
  if (!sessionKey) return;
  session.exitNotified = true;
  const exitLabel = session.exitSignal
    ? `signal ${session.exitSignal}`
    : `code ${session.exitCode ?? 0}`;
  const output = normalizeNotifyOutput(
    tail(session.tail || session.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
  );
  const summary = output
    ? `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel}) :: ${output}`
    : `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel})`;
  enqueueSystemEvent(summary, { sessionKey });
  requestHeartbeatNow({ reason: `exec:${session.id}:exit` });
}

function createApprovalSlug(id: string) {
  return id.slice(0, APPROVAL_SLUG_LENGTH);
}

function resolveApprovalRunningNoticeMs(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_APPROVAL_RUNNING_NOTICE_MS;
  }
  if (value <= 0) return 0;
  return Math.floor(value);
}

function emitExecSystemEvent(text: string, opts: { sessionKey?: string; contextKey?: string }) {
  const sessionKey = opts.sessionKey?.trim();
  if (!sessionKey) return;
  enqueueSystemEvent(text, { sessionKey, contextKey: opts.contextKey });
  requestHeartbeatNow({ reason: "exec-event" });
}

async function runExecProcess(opts: {
  command: string;
  workdir: string;
  env: Record<string, string>;
  sandbox?: BashSandboxConfig;
  containerWorkdir?: string | null;
  usePty: boolean;
  warnings: string[];
  maxOutput: number;
  pendingMaxOutput: number;
  notifyOnExit: boolean;
  scopeKey?: string;
  sessionKey?: string;
  timeoutSec: number;
  onUpdate?: (partialResult: AgentToolResult<ExecToolDetails>) => void;
}): Promise<ExecProcessHandle> {
  const startedAt = Date.now();
  const sessionId = createSessionSlug();
  let child: ChildProcessWithoutNullStreams | null = null;
  let pty: PtyHandle | null = null;
  let stdin: SessionStdin | undefined;

  if (opts.sandbox) {
    child = spawn(
      "docker",
      buildDockerExecArgs({
        containerName: opts.sandbox.containerName,
        command: opts.command,
        workdir: opts.containerWorkdir ?? opts.sandbox.containerWorkdir,
        env: opts.env,
        tty: opts.usePty,
      }),
      {
        cwd: opts.workdir,
        env: process.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    ) as ChildProcessWithoutNullStreams;
    stdin = child.stdin;
  } else if (opts.usePty) {
    const ptyModule = (await import("@lydell/node-pty")) as unknown as {
      spawn?: PtySpawn;
      default?: { spawn?: PtySpawn };
    };
    const spawnPty = ptyModule.spawn ?? ptyModule.default?.spawn;
    if (!spawnPty) {
      throw new Error("PTY support is unavailable (node-pty spawn not found).");
    }
    const { shell, args: shellArgs } = getShellConfig();
    pty = spawnPty(shell, [...shellArgs, opts.command], {
      cwd: opts.workdir,
      env: opts.env,
      name: process.env.TERM ?? "xterm-256color",
      cols: 120,
      rows: 30,
    });
    stdin = {
      destroyed: false,
      write: (data, cb) => {
        try {
          pty?.write(data);
          cb?.(null);
        } catch (err) {
          cb?.(err as Error);
        }
      },
      end: () => {
        try {
          const eof = process.platform === "win32" ? "\x1a" : "\x04";
          pty?.write(eof);
        } catch {
          // ignore EOF errors
        }
      },
    };
  } else {
    const { shell, args: shellArgs } = getShellConfig();
    child = spawn(shell, [...shellArgs, opts.command], {
      cwd: opts.workdir,
      env: opts.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    stdin = child.stdin;
  }

  const session = {
    id: sessionId,
    command: opts.command,
    scopeKey: opts.scopeKey,
    sessionKey: opts.sessionKey,
    notifyOnExit: opts.notifyOnExit,
    exitNotified: false,
    child: child ?? undefined,
    stdin,
    pid: child?.pid ?? pty?.pid,
    startedAt,
    cwd: opts.workdir,
    maxOutputChars: opts.maxOutput,
    pendingMaxOutputChars: opts.pendingMaxOutput,
    totalOutputChars: 0,
    pendingStdout: [],
    pendingStderr: [],
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    aggregated: "",
    tail: "",
    exited: false,
    exitCode: undefined as number | null | undefined,
    exitSignal: undefined as NodeJS.Signals | number | null | undefined,
    truncated: false,
    backgrounded: false,
  } satisfies ProcessSession;
  addSession(session);

  let settled = false;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let timeoutFinalizeTimer: NodeJS.Timeout | null = null;
  let timedOut = false;
  const timeoutFinalizeMs = 1000;
  let resolveFn: ((outcome: ExecProcessOutcome) => void) | null = null;

  const settle = (outcome: ExecProcessOutcome) => {
    if (settled) return;
    settled = true;
    resolveFn?.(outcome);
  };

  const finalizeTimeout = () => {
    if (session.exited) return;
    markExited(session, null, "SIGKILL", "failed");
    maybeNotifyOnExit(session, "failed");
    const aggregated = session.aggregated.trim();
    const reason = `Command timed out after ${opts.timeoutSec} seconds`;
    settle({
      status: "failed",
      exitCode: null,
      exitSignal: "SIGKILL",
      durationMs: Date.now() - startedAt,
      aggregated,
      timedOut: true,
      reason: aggregated ? `${aggregated}\n\n${reason}` : reason,
    });
  };

  const onTimeout = () => {
    timedOut = true;
    killSession(session);
    if (!timeoutFinalizeTimer) {
      timeoutFinalizeTimer = setTimeout(() => {
        finalizeTimeout();
      }, timeoutFinalizeMs);
    }
  };

  if (opts.timeoutSec > 0) {
    timeoutTimer = setTimeout(() => {
      onTimeout();
    }, opts.timeoutSec * 1000);
  }

  const emitUpdate = () => {
    if (!opts.onUpdate) return;
    const tailText = session.tail || session.aggregated;
    const warningText = opts.warnings.length ? `${opts.warnings.join("\n")}\n\n` : "";
    opts.onUpdate({
      content: [{ type: "text", text: warningText + (tailText || "") }],
      details: {
        status: "running",
        sessionId,
        pid: session.pid ?? undefined,
        startedAt,
        cwd: session.cwd,
        tail: session.tail,
      },
    });
  };

  const handleStdout = (data: string) => {
    const str = sanitizeBinaryOutput(data.toString());
    for (const chunk of chunkString(str)) {
      appendOutput(session, "stdout", chunk);
      emitUpdate();
    }
  };

  const handleStderr = (data: string) => {
    const str = sanitizeBinaryOutput(data.toString());
    for (const chunk of chunkString(str)) {
      appendOutput(session, "stderr", chunk);
      emitUpdate();
    }
  };

  if (pty) {
    const cursorResponse = buildCursorPositionResponse();
    pty.onData((data) => {
      const raw = data.toString();
      const { cleaned, requests } = stripDsrRequests(raw);
      if (requests > 0) {
        for (let i = 0; i < requests; i += 1) {
          pty.write(cursorResponse);
        }
      }
      handleStdout(cleaned);
    });
  } else if (child) {
    child.stdout.on("data", handleStdout);
    child.stderr.on("data", handleStderr);
  }

  const promise = new Promise<ExecProcessOutcome>((resolve) => {
    resolveFn = resolve;
    const handleExit = (code: number | null, exitSignal: NodeJS.Signals | number | null) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (timeoutFinalizeTimer) clearTimeout(timeoutFinalizeTimer);
      const durationMs = Date.now() - startedAt;
      const wasSignal = exitSignal != null;
      const isSuccess = code === 0 && !wasSignal && !timedOut;
      const status: "completed" | "failed" = isSuccess ? "completed" : "failed";
      markExited(session, code, exitSignal, status);
      maybeNotifyOnExit(session, status);
      if (!session.child && session.stdin) {
        session.stdin.destroyed = true;
      }

      if (settled) return;
      const aggregated = session.aggregated.trim();
      if (!isSuccess) {
        const reason = timedOut
          ? `Command timed out after ${opts.timeoutSec} seconds`
          : wasSignal && exitSignal
            ? `Command aborted by signal ${exitSignal}`
            : code === null
              ? "Command aborted before exit code was captured"
              : `Command exited with code ${code}`;
        const message = aggregated ? `${aggregated}\n\n${reason}` : reason;
        settle({
          status: "failed",
          exitCode: code ?? null,
          exitSignal: exitSignal ?? null,
          durationMs,
          aggregated,
          timedOut,
          reason: message,
        });
        return;
      }
      settle({
        status: "completed",
        exitCode: code ?? 0,
        exitSignal: exitSignal ?? null,
        durationMs,
        aggregated,
        timedOut: false,
      });
    };

    if (pty) {
      pty.onExit((event) => {
        const rawSignal = event.signal ?? null;
        const normalizedSignal = rawSignal === 0 ? null : rawSignal;
        handleExit(event.exitCode ?? null, normalizedSignal);
      });
    } else if (child) {
      child.once("close", (code, exitSignal) => {
        handleExit(code, exitSignal);
      });

      child.once("error", (err) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (timeoutFinalizeTimer) clearTimeout(timeoutFinalizeTimer);
        markExited(session, null, null, "failed");
        maybeNotifyOnExit(session, "failed");
        const aggregated = session.aggregated.trim();
        const message = aggregated ? `${aggregated}\n\n${String(err)}` : String(err);
        settle({
          status: "failed",
          exitCode: null,
          exitSignal: null,
          durationMs: Date.now() - startedAt,
          aggregated,
          timedOut,
          reason: message,
        });
      });
    }
  });

  return {
    session,
    startedAt,
    pid: session.pid ?? undefined,
    promise,
    kill: () => killSession(session),
  };
}

export function createExecTool(
  defaults?: ExecToolDefaults,
  // biome-ignore lint/suspicious/noExplicitAny: TypeBox schema type from pi-agent-core uses a different module instance.
): AgentTool<any, ExecToolDetails> {
  const defaultBackgroundMs = clampNumber(
    defaults?.backgroundMs ?? readEnvInt("PI_BASH_YIELD_MS"),
    10_000,
    10,
    120_000,
  );
  const allowBackground = defaults?.allowBackground ?? true;
  const defaultTimeoutSec =
    typeof defaults?.timeoutSec === "number" && defaults.timeoutSec > 0
      ? defaults.timeoutSec
      : 1800;
  const defaultPathPrepend = normalizePathPrepend(defaults?.pathPrepend);
  const safeBins = resolveSafeBins(defaults?.safeBins);
  const notifyOnExit = defaults?.notifyOnExit !== false;
  const notifySessionKey = defaults?.sessionKey?.trim() || undefined;
  const approvalRunningNoticeMs = resolveApprovalRunningNoticeMs(defaults?.approvalRunningNoticeMs);
  // Derive agentId only when sessionKey is an agent session key.
  const parsedAgentSession = parseAgentSessionKey(defaults?.sessionKey);
  const agentId =
    defaults?.agentId ??
    (parsedAgentSession ? resolveAgentIdFromSessionKey(defaults?.sessionKey) : undefined);

  return {
    name: "exec",
    label: "exec",
    description:
      "Execute shell commands with background continuation. Use yieldMs/background to continue later via process tool. Use pty=true for TTY-required commands (terminal UIs, coding agents).",
    parameters: execSchema,
    execute: async (_toolCallId, args, signal, onUpdate) => {
      const params = args as {
        command: string;
        workdir?: string;
        env?: Record<string, string>;
        yieldMs?: number;
        background?: boolean;
        timeout?: number;
        pty?: boolean;
        elevated?: boolean;
        host?: string;
        security?: string;
        ask?: string;
        node?: string;
      };

      if (!params.command) {
        throw new Error("Provide a command to start.");
      }

      const maxOutput = DEFAULT_MAX_OUTPUT;
      const pendingMaxOutput = DEFAULT_PENDING_MAX_OUTPUT;
      const warnings: string[] = [];
      const backgroundRequested = params.background === true;
      const yieldRequested = typeof params.yieldMs === "number";
      if (!allowBackground && (backgroundRequested || yieldRequested)) {
        warnings.push("Warning: background execution is disabled; running synchronously.");
      }
      const yieldWindow = allowBackground
        ? backgroundRequested
          ? 0
          : clampNumber(params.yieldMs ?? defaultBackgroundMs, defaultBackgroundMs, 10, 120_000)
        : null;
      const elevatedDefaults = defaults?.elevated;
      const elevatedAllowed = Boolean(elevatedDefaults?.enabled && elevatedDefaults.allowed);
      const elevatedDefaultMode =
        elevatedDefaults?.defaultLevel === "full"
          ? "full"
          : elevatedDefaults?.defaultLevel === "ask"
            ? "ask"
            : elevatedDefaults?.defaultLevel === "on"
              ? "ask"
              : "off";
      const effectiveDefaultMode = elevatedAllowed ? elevatedDefaultMode : "off";
      const elevatedMode =
        typeof params.elevated === "boolean"
          ? params.elevated
            ? elevatedDefaultMode === "full"
              ? "full"
              : "ask"
            : "off"
          : effectiveDefaultMode;
      const elevatedRequested = elevatedMode !== "off";
      if (elevatedRequested) {
        if (!elevatedDefaults?.enabled || !elevatedDefaults.allowed) {
          const runtime = defaults?.sandbox ? "sandboxed" : "direct";
          const gates: string[] = [];
          const contextParts: string[] = [];
          const provider = defaults?.messageProvider?.trim();
          const sessionKey = defaults?.sessionKey?.trim();
          if (provider) contextParts.push(`provider=${provider}`);
          if (sessionKey) contextParts.push(`session=${sessionKey}`);
          if (!elevatedDefaults?.enabled) {
            gates.push("enabled (tools.elevated.enabled / agents.list[].tools.elevated.enabled)");
          } else {
            gates.push(
              "allowFrom (tools.elevated.allowFrom.<provider> / agents.list[].tools.elevated.allowFrom.<provider>)",
            );
          }
          throw new Error(
            [
              `elevated is not available right now (runtime=${runtime}).`,
              `Failing gates: ${gates.join(", ")}`,
              contextParts.length > 0 ? `Context: ${contextParts.join(" ")}` : undefined,
              "Fix-it keys:",
              "- tools.elevated.enabled",
              "- tools.elevated.allowFrom.<provider>",
              "- agents.list[].tools.elevated.enabled",
              "- agents.list[].tools.elevated.allowFrom.<provider>",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
      }
      if (elevatedRequested) {
        logInfo(`exec: elevated command ${truncateMiddle(params.command, 120)}`);
      }
      const configuredHost = defaults?.host ?? "sandbox";
      const requestedHost = normalizeExecHost(params.host) ?? null;
      let host: ExecHost = requestedHost ?? configuredHost;
      if (!elevatedRequested && requestedHost && requestedHost !== configuredHost) {
        throw new Error(
          `exec host not allowed (requested ${renderExecHostLabel(requestedHost)}; ` +
            `configure tools.exec.host=${renderExecHostLabel(configuredHost)} to allow).`,
        );
      }
      if (elevatedRequested) {
        host = "gateway";
      }

      const configuredSecurity = defaults?.security ?? (host === "sandbox" ? "deny" : "allowlist");
      const requestedSecurity = normalizeExecSecurity(params.security);
      let security = minSecurity(configuredSecurity, requestedSecurity ?? configuredSecurity);
      if (elevatedRequested) {
        security = "full";
      }
      const configuredAsk = defaults?.ask ?? "on-miss";
      const requestedAsk = normalizeExecAsk(params.ask);
      let ask = maxAsk(configuredAsk, requestedAsk ?? configuredAsk);
      const bypassApprovals = elevatedRequested && elevatedMode === "full";
      if (bypassApprovals) {
        ask = "off";
      }

      const sandbox = host === "sandbox" ? defaults?.sandbox : undefined;
      const rawWorkdir = params.workdir?.trim() || defaults?.cwd || process.cwd();
      let workdir = rawWorkdir;
      let containerWorkdir = sandbox?.containerWorkdir;
      if (sandbox) {
        const resolved = await resolveSandboxWorkdir({
          workdir: rawWorkdir,
          sandbox,
          warnings,
        });
        workdir = resolved.hostWorkdir;
        containerWorkdir = resolved.containerWorkdir;
      } else {
        workdir = resolveWorkdir(rawWorkdir, warnings);
      }

      const baseEnv = coerceEnv(process.env);
      const mergedEnv = params.env ? { ...baseEnv, ...params.env } : baseEnv;
      const env = sandbox
        ? buildSandboxEnv({
            defaultPath: DEFAULT_PATH,
            paramsEnv: params.env,
            sandboxEnv: sandbox.env,
            containerWorkdir: containerWorkdir ?? sandbox.containerWorkdir,
          })
        : mergedEnv;
      if (!sandbox && host === "gateway" && !params.env?.PATH) {
        const shellPath = getShellPathFromLoginShell({
          env: process.env,
          timeoutMs: resolveShellEnvFallbackTimeoutMs(process.env),
        });
        applyShellPath(env, shellPath);
      }
      applyPathPrepend(env, defaultPathPrepend);

      if (host === "node") {
        const approvals = resolveExecApprovals(
          agentId,
          host === "node" ? { security: "allowlist" } : undefined,
        );
        const hostSecurity = minSecurity(security, approvals.agent.security);
        const hostAsk = maxAsk(ask, approvals.agent.ask);
        const askFallback = approvals.agent.askFallback;
        if (hostSecurity === "deny") {
          throw new Error("exec denied: host=node security=deny");
        }
        const boundNode = defaults?.node?.trim();
        const requestedNode = params.node?.trim();
        if (boundNode && requestedNode && boundNode !== requestedNode) {
          throw new Error(`exec node not allowed (bound to ${boundNode})`);
        }
        const nodeQuery = boundNode || requestedNode;
        const nodes = await listNodes({});
        if (nodes.length === 0) {
          throw new Error(
            "exec host=node requires a paired node (none available). This requires a companion app or node host.",
          );
        }
        let nodeId: string;
        try {
          nodeId = resolveNodeIdFromList(nodes, nodeQuery, !nodeQuery);
        } catch (err) {
          if (!nodeQuery && String(err).includes("node required")) {
            throw new Error(
              "exec host=node requires a node id when multiple nodes are available (set tools.exec.node or exec.node).",
            );
          }
          throw err;
        }
        const nodeInfo = nodes.find((entry) => entry.nodeId === nodeId);
        const supportsSystemRun = Array.isArray(nodeInfo?.commands)
          ? nodeInfo?.commands?.includes("system.run")
          : false;
        if (!supportsSystemRun) {
          throw new Error(
            "exec host=node requires a node that supports system.run (companion app or node host).",
          );
        }
        const argv = buildNodeShellCommand(params.command, nodeInfo?.platform);
        const nodeEnv = params.env ? { ...params.env } : undefined;
        if (nodeEnv) {
          applyPathPrepend(nodeEnv, defaultPathPrepend, { requireExisting: true });
        }
        const analysis = analyzeShellCommand({ command: params.command, cwd: workdir, env });
        let allowlistSatisfied = false;
        if (hostAsk === "on-miss" && hostSecurity === "allowlist") {
          try {
            const approvalsSnapshot = (await callGatewayTool(
              "exec.approvals.node.get",
              { timeoutMs: 10_000 },
              { nodeId },
            )) as { file?: unknown } | null;
            const approvalsFile =
              approvalsSnapshot && typeof approvalsSnapshot === "object"
                ? approvalsSnapshot.file
                : undefined;
            if (approvalsFile && typeof approvalsFile === "object") {
              const resolved = resolveExecApprovalsFromFile({
                file: approvalsFile as ExecApprovalsFile,
                agentId,
                overrides: { security: "allowlist" },
              });
              // Allowlist-only precheck; safe bins are node-local and may diverge.
              allowlistSatisfied = evaluateExecAllowlist({
                analysis,
                allowlist: resolved.allowlist,
                safeBins: new Set(),
                cwd: workdir,
              }).allowlistSatisfied;
            }
          } catch {
            // Fall back to requiring approval if node approvals cannot be fetched.
          }
        }
        const requiresAsk = requiresExecApproval({
          ask: hostAsk,
          security: hostSecurity,
          analysisOk: analysis.ok,
          allowlistSatisfied,
        });
        const commandText = params.command;
        const invokeTimeoutMs = Math.max(
          10_000,
          (typeof params.timeout === "number" ? params.timeout : defaultTimeoutSec) * 1000 + 5_000,
        );
        const buildInvokeParams = (
          approvedByAsk: boolean,
          approvalDecision: "allow-once" | "allow-always" | null,
          runId?: string,
        ) =>
          ({
            nodeId,
            command: "system.run",
            params: {
              command: argv,
              rawCommand: params.command,
              cwd: workdir,
              env: nodeEnv,
              timeoutMs: typeof params.timeout === "number" ? params.timeout * 1000 : undefined,
              agentId,
              sessionKey: defaults?.sessionKey,
              approved: approvedByAsk,
              approvalDecision: approvalDecision ?? undefined,
              runId: runId ?? undefined,
            },
            idempotencyKey: crypto.randomUUID(),
          }) satisfies Record<string, unknown>;

        if (requiresAsk) {
          const approvalId = crypto.randomUUID();
          const approvalSlug = createApprovalSlug(approvalId);
          const expiresAtMs = Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS;
          const contextKey = `exec:${approvalId}`;
          const noticeSeconds = Math.max(1, Math.round(approvalRunningNoticeMs / 1000));
          const warningText = warnings.length ? `${warnings.join("\n")}\n\n` : "";

          void (async () => {
            let decision: string | null = null;
            try {
              const decisionResult = (await callGatewayTool(
                "exec.approval.request",
                { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
                {
                  id: approvalId,
                  command: commandText,
                  cwd: workdir,
                  host: "node",
                  security: hostSecurity,
                  ask: hostAsk,
                  agentId,
                  resolvedPath: undefined,
                  sessionKey: defaults?.sessionKey,
                  timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
                },
              )) as { decision?: string } | null;
              decision =
                decisionResult && typeof decisionResult === "object"
                  ? (decisionResult.decision ?? null)
                  : null;
            } catch {
              emitExecSystemEvent(
                `Exec denied (node=${nodeId} id=${approvalId}, approval-request-failed): ${commandText}`,
                { sessionKey: notifySessionKey, contextKey },
              );
              return;
            }

            let approvedByAsk = false;
            let approvalDecision: "allow-once" | "allow-always" | null = null;
            let deniedReason: string | null = null;

            if (decision === "deny") {
              deniedReason = "user-denied";
            } else if (!decision) {
              if (askFallback === "full") {
                approvedByAsk = true;
                approvalDecision = "allow-once";
              } else if (askFallback === "allowlist") {
                // Defer allowlist enforcement to the node host.
              } else {
                deniedReason = "approval-timeout";
              }
            } else if (decision === "allow-once") {
              approvedByAsk = true;
              approvalDecision = "allow-once";
            } else if (decision === "allow-always") {
              approvedByAsk = true;
              approvalDecision = "allow-always";
            }

            if (deniedReason) {
              emitExecSystemEvent(
                `Exec denied (node=${nodeId} id=${approvalId}, ${deniedReason}): ${commandText}`,
                { sessionKey: notifySessionKey, contextKey },
              );
              return;
            }

            let runningTimer: NodeJS.Timeout | null = null;
            if (approvalRunningNoticeMs > 0) {
              runningTimer = setTimeout(() => {
                emitExecSystemEvent(
                  `Exec running (node=${nodeId} id=${approvalId}, >${noticeSeconds}s): ${commandText}`,
                  { sessionKey: notifySessionKey, contextKey },
                );
              }, approvalRunningNoticeMs);
            }

            try {
              await callGatewayTool(
                "node.invoke",
                { timeoutMs: invokeTimeoutMs },
                buildInvokeParams(approvedByAsk, approvalDecision, approvalId),
              );
            } catch {
              emitExecSystemEvent(
                `Exec denied (node=${nodeId} id=${approvalId}, invoke-failed): ${commandText}`,
                { sessionKey: notifySessionKey, contextKey },
              );
            } finally {
              if (runningTimer) clearTimeout(runningTimer);
            }
          })();

          return {
            content: [
              {
                type: "text",
                text:
                  `${warningText}Approval required (id ${approvalSlug}). ` +
                  "Approve to run; updates will arrive after completion.",
              },
            ],
            details: {
              status: "approval-pending",
              approvalId,
              approvalSlug,
              expiresAtMs,
              host: "node",
              command: commandText,
              cwd: workdir,
              nodeId,
            },
          };
        }

        const startedAt = Date.now();
        const raw = (await callGatewayTool(
          "node.invoke",
          { timeoutMs: invokeTimeoutMs },
          buildInvokeParams(false, null),
        )) as {
          payload?: {
            exitCode?: number;
            timedOut?: boolean;
            success?: boolean;
            stdout?: string;
            stderr?: string;
            error?: string | null;
          };
        };
        const payload = raw?.payload ?? {};
        return {
          content: [
            {
              type: "text",
              text: payload.stdout || payload.stderr || payload.error || "",
            },
          ],
          details: {
            status: payload.success ? "completed" : "failed",
            exitCode: payload.exitCode ?? null,
            durationMs: Date.now() - startedAt,
            aggregated: [payload.stdout, payload.stderr, payload.error].filter(Boolean).join("\n"),
            cwd: workdir,
          } satisfies ExecToolDetails,
        };
      }

      if (host === "gateway" && !bypassApprovals) {
        const approvals = resolveExecApprovals(agentId, { security: "allowlist" });
        const hostSecurity = minSecurity(security, approvals.agent.security);
        const hostAsk = maxAsk(ask, approvals.agent.ask);
        const askFallback = approvals.agent.askFallback;
        if (hostSecurity === "deny") {
          throw new Error("exec denied: host=gateway security=deny");
        }
        const analysis = analyzeShellCommand({ command: params.command, cwd: workdir, env });
        const allowlistEval = evaluateExecAllowlist({
          analysis,
          allowlist: approvals.allowlist,
          safeBins,
          cwd: workdir,
        });
        const allowlistMatches = allowlistEval.allowlistMatches;
        const allowlistSatisfied =
          hostSecurity === "allowlist" && analysis.ok ? allowlistEval.allowlistSatisfied : false;
        const requiresAsk = requiresExecApproval({
          ask: hostAsk,
          security: hostSecurity,
          analysisOk: analysis.ok,
          allowlistSatisfied,
        });

        if (requiresAsk) {
          const approvalId = crypto.randomUUID();
          const approvalSlug = createApprovalSlug(approvalId);
          const expiresAtMs = Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS;
          const contextKey = `exec:${approvalId}`;
          const resolvedPath = analysis.segments[0]?.resolution?.resolvedPath;
          const noticeSeconds = Math.max(1, Math.round(approvalRunningNoticeMs / 1000));
          const commandText = params.command;
          const effectiveTimeout =
            typeof params.timeout === "number" ? params.timeout : defaultTimeoutSec;
          const warningText = warnings.length ? `${warnings.join("\n")}\n\n` : "";

          void (async () => {
            let decision: string | null = null;
            try {
              const decisionResult = (await callGatewayTool(
                "exec.approval.request",
                { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
                {
                  id: approvalId,
                  command: commandText,
                  cwd: workdir,
                  host: "gateway",
                  security: hostSecurity,
                  ask: hostAsk,
                  agentId,
                  resolvedPath,
                  sessionKey: defaults?.sessionKey,
                  timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
                },
              )) as { decision?: string } | null;
              decision =
                decisionResult && typeof decisionResult === "object"
                  ? (decisionResult.decision ?? null)
                  : null;
            } catch {
              emitExecSystemEvent(
                `Exec denied (gateway id=${approvalId}, approval-request-failed): ${commandText}`,
                { sessionKey: notifySessionKey, contextKey },
              );
              return;
            }

            let approvedByAsk = false;
            let deniedReason: string | null = null;

            if (decision === "deny") {
              deniedReason = "user-denied";
            } else if (!decision) {
              if (askFallback === "full") {
                approvedByAsk = true;
              } else if (askFallback === "allowlist") {
                if (!analysis.ok || !allowlistSatisfied) {
                  deniedReason = "approval-timeout (allowlist-miss)";
                } else {
                  approvedByAsk = true;
                }
              } else {
                deniedReason = "approval-timeout";
              }
            } else if (decision === "allow-once") {
              approvedByAsk = true;
            } else if (decision === "allow-always") {
              approvedByAsk = true;
              if (hostSecurity === "allowlist") {
                for (const segment of analysis.segments) {
                  const pattern = segment.resolution?.resolvedPath ?? "";
                  if (pattern) {
                    addAllowlistEntry(approvals.file, agentId, pattern);
                  }
                }
              }
            }

            if (
              hostSecurity === "allowlist" &&
              (!analysis.ok || !allowlistSatisfied) &&
              !approvedByAsk
            ) {
              deniedReason = deniedReason ?? "allowlist-miss";
            }

            if (deniedReason) {
              emitExecSystemEvent(
                `Exec denied (gateway id=${approvalId}, ${deniedReason}): ${commandText}`,
                { sessionKey: notifySessionKey, contextKey },
              );
              return;
            }

            if (allowlistMatches.length > 0) {
              const seen = new Set<string>();
              for (const match of allowlistMatches) {
                if (seen.has(match.pattern)) continue;
                seen.add(match.pattern);
                recordAllowlistUse(
                  approvals.file,
                  agentId,
                  match,
                  commandText,
                  resolvedPath ?? undefined,
                );
              }
            }

            let run: ExecProcessHandle | null = null;
            try {
              run = await runExecProcess({
                command: commandText,
                workdir,
                env,
                sandbox: undefined,
                containerWorkdir: null,
                usePty: params.pty === true && !sandbox,
                warnings,
                maxOutput,
                pendingMaxOutput,
                notifyOnExit: false,
                scopeKey: defaults?.scopeKey,
                sessionKey: notifySessionKey,
                timeoutSec: effectiveTimeout,
              });
            } catch {
              emitExecSystemEvent(
                `Exec denied (gateway id=${approvalId}, spawn-failed): ${commandText}`,
                { sessionKey: notifySessionKey, contextKey },
              );
              return;
            }

            markBackgrounded(run.session);

            let runningTimer: NodeJS.Timeout | null = null;
            if (approvalRunningNoticeMs > 0) {
              runningTimer = setTimeout(() => {
                emitExecSystemEvent(
                  `Exec running (gateway id=${approvalId}, session=${run?.session.id}, >${noticeSeconds}s): ${commandText}`,
                  { sessionKey: notifySessionKey, contextKey },
                );
              }, approvalRunningNoticeMs);
            }

            const outcome = await run.promise;
            if (runningTimer) clearTimeout(runningTimer);
            const output = normalizeNotifyOutput(
              tail(outcome.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
            );
            const exitLabel = outcome.timedOut ? "timeout" : `code ${outcome.exitCode ?? "?"}`;
            const summary = output
              ? `Exec finished (gateway id=${approvalId}, session=${run.session.id}, ${exitLabel})\n${output}`
              : `Exec finished (gateway id=${approvalId}, session=${run.session.id}, ${exitLabel})`;
            emitExecSystemEvent(summary, { sessionKey: notifySessionKey, contextKey });
          })();

          return {
            content: [
              {
                type: "text",
                text:
                  `${warningText}` +
                  `Approval required (id ${approvalSlug}). ` +
                  "Approve to run; updates will arrive after completion.",
              },
            ],
            details: {
              status: "approval-pending",
              approvalId,
              approvalSlug,
              expiresAtMs,
              host: "gateway",
              command: params.command,
              cwd: workdir,
            },
          };
        }

        if (hostSecurity === "allowlist" && (!analysis.ok || !allowlistSatisfied)) {
          throw new Error("exec denied: allowlist miss");
        }

        if (allowlistMatches.length > 0) {
          const seen = new Set<string>();
          for (const match of allowlistMatches) {
            if (seen.has(match.pattern)) continue;
            seen.add(match.pattern);
            recordAllowlistUse(
              approvals.file,
              agentId,
              match,
              params.command,
              analysis.segments[0]?.resolution?.resolvedPath,
            );
          }
        }
      }

      const effectiveTimeout =
        typeof params.timeout === "number" ? params.timeout : defaultTimeoutSec;
      const warningText = warnings.length ? `${warnings.join("\n")}\n\n` : "";
      const usePty = params.pty === true && !sandbox;
      const run = await runExecProcess({
        command: params.command,
        workdir,
        env,
        sandbox,
        containerWorkdir,
        usePty,
        warnings,
        maxOutput,
        pendingMaxOutput,
        notifyOnExit,
        scopeKey: defaults?.scopeKey,
        sessionKey: notifySessionKey,
        timeoutSec: effectiveTimeout,
        onUpdate,
      });

      let yielded = false;
      let yieldTimer: NodeJS.Timeout | null = null;

      // Tool-call abort should not kill backgrounded sessions; timeouts still must.
      const onAbortSignal = () => {
        if (yielded || run.session.backgrounded) return;
        run.kill();
      };

      if (signal?.aborted) onAbortSignal();
      else if (signal) {
        signal.addEventListener("abort", onAbortSignal, { once: true });
      }

      return new Promise<AgentToolResult<ExecToolDetails>>((resolve, reject) => {
        const resolveRunning = () =>
          resolve({
            content: [
              {
                type: "text",
                text:
                  `${warningText}` +
                  `Command still running (session ${run.session.id}, pid ${
                    run.session.pid ?? "n/a"
                  }). ` +
                  "Use process (list/poll/log/write/kill/clear/remove) for follow-up.",
              },
            ],
            details: {
              status: "running",
              sessionId: run.session.id,
              pid: run.session.pid ?? undefined,
              startedAt: run.startedAt,
              cwd: run.session.cwd,
              tail: run.session.tail,
            },
          });

        const onYieldNow = () => {
          if (yieldTimer) clearTimeout(yieldTimer);
          if (yielded) return;
          yielded = true;
          markBackgrounded(run.session);
          resolveRunning();
        };

        if (allowBackground && yieldWindow !== null) {
          if (yieldWindow === 0) {
            onYieldNow();
          } else {
            yieldTimer = setTimeout(() => {
              if (yielded) return;
              yielded = true;
              markBackgrounded(run.session);
              resolveRunning();
            }, yieldWindow);
          }
        }

        run.promise
          .then((outcome) => {
            if (yieldTimer) clearTimeout(yieldTimer);
            if (yielded || run.session.backgrounded) return;
            if (outcome.status === "failed") {
              reject(new Error(outcome.reason ?? "Command failed."));
              return;
            }
            resolve({
              content: [
                {
                  type: "text",
                  text: `${warningText}${outcome.aggregated || "(no output)"}`,
                },
              ],
              details: {
                status: "completed",
                exitCode: outcome.exitCode ?? 0,
                durationMs: outcome.durationMs,
                aggregated: outcome.aggregated,
                cwd: run.session.cwd,
              },
            });
          })
          .catch((err) => {
            if (yieldTimer) clearTimeout(yieldTimer);
            if (yielded || run.session.backgrounded) return;
            reject(err as Error);
          });
      });
    },
  };
}

export const execTool = createExecTool();
