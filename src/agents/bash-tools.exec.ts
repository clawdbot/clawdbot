import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

import {
  type ExecAsk,
  type ExecHost,
  type ExecSecurity,
  addAllowlistEntry,
  matchAllowlist,
  maxAsk,
  minSecurity,
  recordAllowlistUse,
  requestExecApprovalViaSocket,
  resolveCommandResolution,
  resolveExecApprovals,
} from "../infra/exec-approvals.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
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

const DEFAULT_MAX_OUTPUT = clampNumber(
  readEnvInt("PI_BASH_MAX_OUTPUT_CHARS"),
  30_000,
  1_000,
  150_000,
);
const DEFAULT_PENDING_MAX_OUTPUT = clampNumber(
  readEnvInt("CLAWDBOT_BASH_PENDING_MAX_OUTPUT_CHARS"),
  30_000,
  1_000,
  150_000,
);
const DEFAULT_PATH =
  process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_NOTIFY_TAIL_CHARS = 400;

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

export type ExecToolDefaults = {
  host?: ExecHost;
  security?: ExecSecurity;
  ask?: ExecAsk;
  node?: string;
  agentId?: string;
  backgroundMs?: number;
  timeoutSec?: number;
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
  defaultLevel: "on" | "off";
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
  const notifyOnExit = defaults?.notifyOnExit !== false;
  const notifySessionKey = defaults?.sessionKey?.trim() || undefined;

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
      const startedAt = Date.now();
      const sessionId = createSessionSlug();
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
      const elevatedDefaultOn =
        elevatedDefaults?.defaultLevel === "on" &&
        elevatedDefaults.enabled &&
        elevatedDefaults.allowed;
      const elevatedRequested =
        typeof params.elevated === "boolean" ? params.elevated : elevatedDefaultOn;
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
        logInfo(
          `exec: elevated command (${sessionId.slice(0, 8)}) ${truncateMiddle(
            params.command,
            120,
          )}`,
        );
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

      const configuredSecurity = defaults?.security ?? "deny";
      const requestedSecurity = normalizeExecSecurity(params.security);
      let security = minSecurity(configuredSecurity, requestedSecurity ?? configuredSecurity);
      if (elevatedRequested) {
        security = "full";
      }
      const configuredAsk = defaults?.ask ?? "on-miss";
      const requestedAsk = normalizeExecAsk(params.ask);
      let ask = maxAsk(configuredAsk, requestedAsk ?? configuredAsk);

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

      const { shell, args: shellArgs } = getShellConfig();
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

      if (host === "node") {
        if (security === "deny") {
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
        const invokeParams: Record<string, unknown> = {
          nodeId,
          command: "system.run",
          params: {
            command: argv,
            rawCommand: params.command,
            cwd: workdir,
            env: params.env,
            timeoutMs: typeof params.timeout === "number" ? params.timeout * 1000 : undefined,
            agentId: defaults?.agentId,
            sessionKey: defaults?.sessionKey,
          },
          idempotencyKey: crypto.randomUUID(),
        };
        const raw = (await callGatewayTool("node.invoke", {}, invokeParams)) as {
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

      if (host === "gateway") {
        const approvals = resolveExecApprovals(defaults?.agentId);
        const hostSecurity = minSecurity(security, approvals.agent.security);
        const hostAsk = maxAsk(ask, approvals.agent.ask);
        const askFallback = approvals.agent.askFallback;
        if (hostSecurity === "deny") {
          throw new Error("exec denied: host=gateway security=deny");
        }

        const resolution = resolveCommandResolution(params.command, workdir, env);
        const allowlistMatch =
          hostSecurity === "allowlist" ? matchAllowlist(approvals.allowlist, resolution) : null;
        const requiresAsk =
          hostAsk === "always" ||
          (hostAsk === "on-miss" && hostSecurity === "allowlist" && !allowlistMatch);

        let approvedByAsk = false;
        if (requiresAsk) {
          const decision =
            (await requestExecApprovalViaSocket({
              socketPath: approvals.socketPath,
              token: approvals.token,
              request: {
                command: params.command,
                cwd: workdir,
                host: "gateway",
                security: hostSecurity,
                ask: hostAsk,
                agentId: defaults?.agentId,
                resolvedPath: resolution?.resolvedPath ?? null,
              },
            })) ?? null;

          if (decision === "deny") {
            throw new Error("exec denied: user denied");
          }
          if (!decision) {
            if (askFallback === "full") {
              approvedByAsk = true;
            } else if (askFallback === "allowlist") {
              if (!allowlistMatch) {
                throw new Error(
                  "exec denied: approval required (companion app approval UI not available)",
                );
              }
              approvedByAsk = true;
            } else {
              throw new Error(
                "exec denied: approval required (companion app approval UI not available)",
              );
            }
          }
          if (decision === "allow-once") {
            approvedByAsk = true;
          }
          if (decision === "allow-always") {
            approvedByAsk = true;
            if (hostSecurity === "allowlist") {
              const pattern =
                resolution?.resolvedPath ??
                resolution?.rawExecutable ??
                params.command.split(/\s+/).shift() ??
                "";
              if (pattern) {
                addAllowlistEntry(approvals.file, defaults?.agentId, pattern);
              }
            }
          }
        }

        if (hostSecurity === "allowlist" && !allowlistMatch && !approvedByAsk) {
          throw new Error("exec denied: allowlist miss");
        }

        if (allowlistMatch) {
          recordAllowlistUse(
            approvals.file,
            defaults?.agentId,
            allowlistMatch,
            params.command,
            resolution?.resolvedPath,
          );
        }
      }

      const usePty = params.pty === true && !sandbox;
      let child: ChildProcessWithoutNullStreams | null = null;
      let pty: PtyHandle | null = null;
      let stdin: SessionStdin | undefined;

      if (sandbox) {
        child = spawn(
          "docker",
          buildDockerExecArgs({
            containerName: sandbox.containerName,
            command: params.command,
            workdir: containerWorkdir ?? sandbox.containerWorkdir,
            env,
            tty: params.pty === true,
          }),
          {
            cwd: workdir,
            env: process.env,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          },
        ) as ChildProcessWithoutNullStreams;
        stdin = child.stdin;
      } else if (usePty) {
        const ptyModule = (await import("@lydell/node-pty")) as unknown as {
          spawn?: PtySpawn;
          default?: { spawn?: PtySpawn };
        };
        const spawnPty = ptyModule.spawn ?? ptyModule.default?.spawn;
        if (!spawnPty) {
          throw new Error("PTY support is unavailable (node-pty spawn not found).");
        }
        pty = spawnPty(shell, [...shellArgs, params.command], {
          cwd: workdir,
          env,
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
        child = spawn(shell, [...shellArgs, params.command], {
          cwd: workdir,
          env,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        }) as ChildProcessWithoutNullStreams;
        stdin = child.stdin;
      }

      const session = {
        id: sessionId,
        command: params.command,
        scopeKey: defaults?.scopeKey,
        sessionKey: notifySessionKey,
        notifyOnExit,
        exitNotified: false,
        child: child ?? undefined,
        stdin,
        pid: child?.pid ?? pty?.pid,
        startedAt,
        cwd: workdir,
        maxOutputChars: maxOutput,
        pendingMaxOutputChars: pendingMaxOutput,
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
      };
      addSession(session);

      let settled = false;
      let yielded = false;
      let yieldTimer: NodeJS.Timeout | null = null;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let timeoutFinalizeTimer: NodeJS.Timeout | null = null;
      let timedOut = false;
      const timeoutFinalizeMs = 1000;
      let rejectFn: ((err: Error) => void) | null = null;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const effectiveTimeout =
        typeof params.timeout === "number" ? params.timeout : defaultTimeoutSec;
      const finalizeTimeout = () => {
        if (session.exited) return;
        markExited(session, null, "SIGKILL", "failed");
        maybeNotifyOnExit(session, "failed");
        if (settled || !rejectFn) return;
        const aggregated = session.aggregated.trim();
        const reason = `Command timed out after ${effectiveTimeout} seconds`;
        const message = aggregated ? `${aggregated}\n\n${reason}` : reason;
        settle(() => rejectFn?.(new Error(message)));
      };

      // Tool-call abort should not kill backgrounded sessions; timeouts still must.
      const onAbortSignal = () => {
        if (yielded || session.backgrounded) return;
        killSession(session);
      };

      // Timeouts always terminate, even for backgrounded sessions.
      const onTimeout = () => {
        timedOut = true;
        killSession(session);
        if (!timeoutFinalizeTimer) {
          timeoutFinalizeTimer = setTimeout(() => {
            finalizeTimeout();
          }, timeoutFinalizeMs);
        }
      };

      if (signal?.aborted) onAbortSignal();
      else if (signal) {
        signal.addEventListener("abort", onAbortSignal, { once: true });
      }
      if (effectiveTimeout > 0) {
        timeoutTimer = setTimeout(() => {
          onTimeout();
        }, effectiveTimeout * 1000);
      }

      const emitUpdate = () => {
        if (!onUpdate) return;
        const tailText = session.tail || session.aggregated;
        const warningText = warnings.length ? `${warnings.join("\n")}\n\n` : "";
        onUpdate({
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

      return new Promise<AgentToolResult<ExecToolDetails>>((resolve, reject) => {
        rejectFn = reject;
        const resolveRunning = () => {
          settle(() =>
            resolve({
              content: [
                {
                  type: "text",
                  text:
                    `${warnings.length ? `${warnings.join("\n")}\n\n` : ""}` +
                    `Command still running (session ${sessionId}, pid ${session.pid ?? "n/a"}). ` +
                    "Use process (list/poll/log/write/kill/clear/remove) for follow-up.",
                },
              ],
              details: {
                status: "running",
                sessionId,
                pid: session.pid ?? undefined,
                startedAt,
                cwd: session.cwd,
                tail: session.tail,
              },
            }),
          );
        };

        const onYieldNow = () => {
          if (yieldTimer) clearTimeout(yieldTimer);
          if (settled) return;
          yielded = true;
          markBackgrounded(session);
          resolveRunning();
        };

        if (allowBackground && yieldWindow !== null) {
          if (yieldWindow === 0) {
            onYieldNow();
          } else {
            yieldTimer = setTimeout(() => {
              if (settled) return;
              yielded = true;
              markBackgrounded(session);
              resolveRunning();
            }, yieldWindow);
          }
        }

        const handleExit = (code: number | null, exitSignal: NodeJS.Signals | number | null) => {
          if (yieldTimer) clearTimeout(yieldTimer);
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (timeoutFinalizeTimer) clearTimeout(timeoutFinalizeTimer);
          const durationMs = Date.now() - startedAt;
          const wasSignal = exitSignal != null;
          const isSuccess = code === 0 && !wasSignal && !signal?.aborted && !timedOut;
          const status: "completed" | "failed" = isSuccess ? "completed" : "failed";
          markExited(session, code, exitSignal, status);
          maybeNotifyOnExit(session, status);
          if (!session.child && session.stdin) {
            session.stdin.destroyed = true;
          }

          if (yielded || session.backgrounded) return;

          const aggregated = session.aggregated.trim();
          if (!isSuccess) {
            const reason = timedOut
              ? `Command timed out after ${effectiveTimeout} seconds`
              : wasSignal && exitSignal
                ? `Command aborted by signal ${exitSignal}`
                : code === null
                  ? "Command aborted before exit code was captured"
                  : `Command exited with code ${code}`;
            const message = aggregated ? `${aggregated}\n\n${reason}` : reason;
            settle(() => reject(new Error(message)));
            return;
          }

          settle(() =>
            resolve({
              content: [
                {
                  type: "text",
                  text:
                    `${warnings.length ? `${warnings.join("\n")}\n\n` : ""}` +
                    (aggregated || "(no output)"),
                },
              ],
              details: {
                status: "completed",
                exitCode: code ?? 0,
                durationMs,
                aggregated,
                cwd: session.cwd,
              },
            }),
          );
        };

        // `exit` can fire before stdio fully flushes (notably on Windows).
        // `close` waits for streams to close, so aggregated output is complete.
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
            if (yieldTimer) clearTimeout(yieldTimer);
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (timeoutFinalizeTimer) clearTimeout(timeoutFinalizeTimer);
            markExited(session, null, null, "failed");
            maybeNotifyOnExit(session, "failed");
            settle(() => reject(err));
          });
        }
      });
    },
  };
}

export const execTool = createExecTool();
