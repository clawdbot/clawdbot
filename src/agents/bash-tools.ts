import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

import { logInfo } from "../logger.js";
import { sliceUtf16Safe } from "../utils.js";
import {
  addSession,
  appendOutput,
  deleteSession,
  drainSession,
  getFinishedSession,
  getSession,
  listFinishedSessions,
  listRunningSessions,
  markBackgrounded,
  markExited,
  setJobTtlMs,
} from "./bash-process-registry.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import {
  getShellConfig,
  killProcessTree,
  sanitizeBinaryOutput,
} from "./shell-utils.js";

const CHUNK_LIMIT = 8 * 1024;
const DEFAULT_MAX_OUTPUT = clampNumber(
  readEnvInt("PI_BASH_MAX_OUTPUT_CHARS"),
  30_000,
  1_000,
  150_000,
);
const DEFAULT_PATH =
  process.env.PATH ??
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export type ExecToolDefaults = {
  backgroundMs?: number;
  timeoutSec?: number;
  sandbox?: BashSandboxConfig;
  elevated?: ExecElevatedDefaults;
  allowBackground?: boolean;
  scopeKey?: string;
  cwd?: string;
};

export type ProcessToolDefaults = {
  cleanupMs?: number;
  scopeKey?: string;
};

export type BashSandboxConfig = {
  containerName: string;
  workspaceDir: string;
  containerWorkdir: string;
  env?: Record<string, string>;
};

export type ExecElevatedDefaults = {
  enabled: boolean;
  allowed: boolean;
  defaultLevel: "on" | "off";
};

const execSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  workdir: Type.Optional(
    Type.String({ description: "Working directory (defaults to cwd)" }),
  ),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  yieldMs: Type.Optional(
    Type.Number({
      description: "Milliseconds to wait before backgrounding (default 10000)",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({ description: "Run in background immediately" }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, kills process on expiry)",
    }),
  ),
  elevated: Type.Optional(
    Type.Boolean({
      description: "Run on the host with elevated permissions (if allowed)",
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

  return {
    name: "exec",
    label: "exec",
    description:
      "Execute shell commands with background continuation. Use yieldMs/background to continue later via process tool. For real TTY mode, use the tmux skill.",
    parameters: execSchema,
    execute: async (_toolCallId, args, signal, onUpdate) => {
      const params = args as {
        command: string;
        workdir?: string;
        env?: Record<string, string>;
        yieldMs?: number;
        background?: boolean;
        timeout?: number;
        elevated?: boolean;
      };

      if (!params.command) {
        throw new Error("Provide a command to start.");
      }

      const maxOutput = DEFAULT_MAX_OUTPUT;
      const startedAt = Date.now();
      const sessionId = randomUUID();
      const warnings: string[] = [];
      const backgroundRequested = params.background === true;
      const yieldRequested = typeof params.yieldMs === "number";
      if (!allowBackground && (backgroundRequested || yieldRequested)) {
        warnings.push(
          "Warning: background execution is disabled; running synchronously.",
        );
      }
      const yieldWindow = allowBackground
        ? backgroundRequested
          ? 0
          : clampNumber(
              params.yieldMs ?? defaultBackgroundMs,
              defaultBackgroundMs,
              10,
              120_000,
            )
        : null;
      const elevatedDefaults = defaults?.elevated;
      const elevatedDefaultOn =
        elevatedDefaults?.defaultLevel === "on" &&
        elevatedDefaults.enabled &&
        elevatedDefaults.allowed;
      const elevatedRequested =
        typeof params.elevated === "boolean"
          ? params.elevated
          : elevatedDefaultOn;
      if (elevatedRequested) {
        if (!elevatedDefaults?.enabled || !elevatedDefaults.allowed) {
          const runtime = defaults?.sandbox ? "sandboxed" : "direct";
          const gates: string[] = [];
          if (!elevatedDefaults?.enabled) {
            gates.push(
              "enabled (tools.elevated.enabled / agents.list[].tools.elevated.enabled)",
            );
          } else {
            gates.push(
              "allowFrom (tools.elevated.allowFrom.<provider> / agents.list[].tools.elevated.allowFrom.<provider>)",
            );
          }
          throw new Error(
            [
              `elevated is not available right now (runtime=${runtime}).`,
              `Failing gates: ${gates.join(", ")}`,
              "Fix-it keys:",
              "- tools.elevated.enabled",
              "- tools.elevated.allowFrom.<provider>",
              "- agents.list[].tools.elevated.enabled",
              "- agents.list[].tools.elevated.allowFrom.<provider>",
            ].join("\n"),
          );
        }
        logInfo(
          `exec: elevated command (${sessionId.slice(0, 8)}) ${truncateMiddle(
            params.command,
            120,
          )}`,
        );
      }

      const sandbox = elevatedRequested ? undefined : defaults?.sandbox;
      const rawWorkdir =
        params.workdir?.trim() || defaults?.cwd || process.cwd();
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
            paramsEnv: params.env,
            sandboxEnv: sandbox.env,
            containerWorkdir: containerWorkdir ?? sandbox.containerWorkdir,
          })
        : mergedEnv;
      const child = sandbox
        ? spawn(
            "docker",
            buildDockerExecArgs({
              containerName: sandbox.containerName,
              command: params.command,
              workdir: containerWorkdir ?? sandbox.containerWorkdir,
              env,
              tty: false,
            }),
            {
              cwd: workdir,
              env: process.env,
              detached: process.platform !== "win32",
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            },
          )
        : spawn(shell, [...shellArgs, params.command], {
            cwd: workdir,
            env,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });

      const session = {
        id: sessionId,
        command: params.command,
        scopeKey: defaults?.scopeKey,
        child,
        pid: child?.pid,
        startedAt,
        cwd: workdir,
        maxOutputChars: maxOutput,
        totalOutputChars: 0,
        pendingStdout: [],
        pendingStderr: [],
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
      let timedOut = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const onAbort = () => {
        killSession(session);
      };

      if (signal?.aborted) onAbort();
      else if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const effectiveTimeout =
        typeof params.timeout === "number" ? params.timeout : defaultTimeoutSec;
      if (effectiveTimeout > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          onAbort();
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

      child.stdout.on("data", (data) => {
        const str = sanitizeBinaryOutput(data.toString());
        for (const chunk of chunkString(str)) {
          appendOutput(session, "stdout", chunk);
          emitUpdate();
        }
      });

      child.stderr.on("data", (data) => {
        const str = sanitizeBinaryOutput(data.toString());
        for (const chunk of chunkString(str)) {
          appendOutput(session, "stderr", chunk);
          emitUpdate();
        }
      });

      return new Promise<AgentToolResult<ExecToolDetails>>(
        (resolve, reject) => {
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

          const handleExit = (
            code: number | null,
            exitSignal: NodeJS.Signals | number | null,
          ) => {
            if (yieldTimer) clearTimeout(yieldTimer);
            if (timeoutTimer) clearTimeout(timeoutTimer);
            const durationMs = Date.now() - startedAt;
            const wasSignal = exitSignal != null;
            const isSuccess =
              code === 0 && !wasSignal && !signal?.aborted && !timedOut;
            const status: "completed" | "failed" = isSuccess
              ? "completed"
              : "failed";
            markExited(session, code, exitSignal, status);

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
              const message = aggregated
                ? `${aggregated}\n\n${reason}`
                : reason;
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
          child.once("close", (code, exitSignal) => {
            handleExit(code, exitSignal);
          });

          child.once("error", (err) => {
            if (yieldTimer) clearTimeout(yieldTimer);
            if (timeoutTimer) clearTimeout(timeoutTimer);
            markExited(session, null, null, "failed");
            settle(() => reject(err));
          });
        },
      );
    },
  };
}

export const execTool = createExecTool();

const processSchema = Type.Object({
  action: Type.String({ description: "Process action" }),
  sessionId: Type.Optional(
    Type.String({ description: "Session id for actions other than list" }),
  ),
  data: Type.Optional(Type.String({ description: "Data to write for write" })),
  eof: Type.Optional(Type.Boolean({ description: "Close stdin after write" })),
  offset: Type.Optional(Type.Number({ description: "Log offset" })),
  limit: Type.Optional(Type.Number({ description: "Log length" })),
});

export function createProcessTool(
  defaults?: ProcessToolDefaults,
  // biome-ignore lint/suspicious/noExplicitAny: TypeBox schema type from pi-agent-core uses a different module instance.
): AgentTool<any> {
  if (defaults?.cleanupMs !== undefined) {
    setJobTtlMs(defaults.cleanupMs);
  }
  const scopeKey = defaults?.scopeKey;
  const isInScope = (session?: { scopeKey?: string } | null) =>
    !scopeKey || session?.scopeKey === scopeKey;

  return {
    name: "process",
    label: "process",
    description: "Manage running exec sessions: list, poll, log, write, kill.",
    parameters: processSchema,
    execute: async (_toolCallId, args) => {
      const params = args as {
        action: "list" | "poll" | "log" | "write" | "kill" | "clear" | "remove";
        sessionId?: string;
        data?: string;
        eof?: boolean;
        offset?: number;
        limit?: number;
      };

      if (params.action === "list") {
        const running = listRunningSessions()
          .filter((s) => isInScope(s))
          .map((s) => ({
            sessionId: s.id,
            status: "running",
            pid: s.pid ?? undefined,
            startedAt: s.startedAt,
            runtimeMs: Date.now() - s.startedAt,
            cwd: s.cwd,
            command: s.command,
            name: deriveSessionName(s.command),
            tail: s.tail,
            truncated: s.truncated,
          }));
        const finished = listFinishedSessions()
          .filter((s) => isInScope(s))
          .map((s) => ({
            sessionId: s.id,
            status: s.status,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            runtimeMs: s.endedAt - s.startedAt,
            cwd: s.cwd,
            command: s.command,
            name: deriveSessionName(s.command),
            tail: s.tail,
            truncated: s.truncated,
            exitCode: s.exitCode ?? undefined,
            exitSignal: s.exitSignal ?? undefined,
          }));
        const lines = [...running, ...finished]
          .sort((a, b) => b.startedAt - a.startedAt)
          .map((s) => {
            const label = s.name
              ? truncateMiddle(s.name, 80)
              : truncateMiddle(s.command, 120);
            return `${s.sessionId.slice(0, 8)} ${pad(
              s.status,
              9,
            )} ${formatDuration(s.runtimeMs)} :: ${label}`;
          });
        return {
          content: [
            {
              type: "text",
              text: lines.join("\n") || "No running or recent sessions.",
            },
          ],
          details: { status: "completed", sessions: [...running, ...finished] },
        };
      }

      if (!params.sessionId) {
        return {
          content: [
            { type: "text", text: "sessionId is required for this action." },
          ],
          details: { status: "failed" },
        };
      }

      const session = getSession(params.sessionId);
      const finished = getFinishedSession(params.sessionId);
      const scopedSession = isInScope(session) ? session : undefined;
      const scopedFinished = isInScope(finished) ? finished : undefined;

      switch (params.action) {
        case "poll": {
          if (!scopedSession) {
            if (scopedFinished) {
              return {
                content: [
                  {
                    type: "text",
                    text:
                      (scopedFinished.tail ||
                        `(no output recorded${
                          scopedFinished.truncated ? " — truncated to cap" : ""
                        })`) +
                      `\n\nProcess exited with ${
                        scopedFinished.exitSignal
                          ? `signal ${scopedFinished.exitSignal}`
                          : `code ${scopedFinished.exitCode ?? 0}`
                      }.`,
                  },
                ],
                details: {
                  status:
                    scopedFinished.status === "completed"
                      ? "completed"
                      : "failed",
                  sessionId: params.sessionId,
                  exitCode: scopedFinished.exitCode ?? undefined,
                  aggregated: scopedFinished.aggregated,
                  name: deriveSessionName(scopedFinished.command),
                },
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: `No session found for ${params.sessionId}`,
                },
              ],
              details: { status: "failed" },
            };
          }
          if (!scopedSession.backgrounded) {
            return {
              content: [
                {
                  type: "text",
                  text: `Session ${params.sessionId} is not backgrounded.`,
                },
              ],
              details: { status: "failed" },
            };
          }
          const { stdout, stderr } = drainSession(scopedSession);
          const exited = scopedSession.exited;
          const exitCode = scopedSession.exitCode ?? 0;
          const exitSignal = scopedSession.exitSignal ?? undefined;
          if (exited) {
            const status =
              exitCode === 0 && exitSignal == null ? "completed" : "failed";
            markExited(
              scopedSession,
              scopedSession.exitCode ?? null,
              scopedSession.exitSignal ?? null,
              status,
            );
          }
          const status = exited
            ? exitCode === 0 && exitSignal == null
              ? "completed"
              : "failed"
            : "running";
          const output = [stdout.trimEnd(), stderr.trimEnd()]
            .filter(Boolean)
            .join("\n")
            .trim();
          return {
            content: [
              {
                type: "text",
                text:
                  (output || "(no new output)") +
                  (exited
                    ? `\n\nProcess exited with ${
                        exitSignal ? `signal ${exitSignal}` : `code ${exitCode}`
                      }.`
                    : "\n\nProcess still running."),
              },
            ],
            details: {
              status,
              sessionId: params.sessionId,
              exitCode: exited ? exitCode : undefined,
              aggregated: scopedSession.aggregated,
              name: deriveSessionName(scopedSession.command),
            },
          };
        }

        case "log": {
          if (scopedSession) {
            if (!scopedSession.backgrounded) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Session ${params.sessionId} is not backgrounded.`,
                  },
                ],
                details: { status: "failed" },
              };
            }
            const { slice, totalLines, totalChars } = sliceLogLines(
              scopedSession.aggregated,
              params.offset,
              params.limit,
            );
            return {
              content: [{ type: "text", text: slice || "(no output yet)" }],
              details: {
                status: scopedSession.exited ? "completed" : "running",
                sessionId: params.sessionId,
                total: totalLines,
                totalLines,
                totalChars,
                truncated: scopedSession.truncated,
                name: deriveSessionName(scopedSession.command),
              },
            };
          }
          if (scopedFinished) {
            const { slice, totalLines, totalChars } = sliceLogLines(
              scopedFinished.aggregated,
              params.offset,
              params.limit,
            );
            const status =
              scopedFinished.status === "completed" ? "completed" : "failed";
            return {
              content: [
                { type: "text", text: slice || "(no output recorded)" },
              ],
              details: {
                status,
                sessionId: params.sessionId,
                total: totalLines,
                totalLines,
                totalChars,
                truncated: scopedFinished.truncated,
                exitCode: scopedFinished.exitCode ?? undefined,
                exitSignal: scopedFinished.exitSignal ?? undefined,
                name: deriveSessionName(scopedFinished.command),
              },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `No session found for ${params.sessionId}`,
              },
            ],
            details: { status: "failed" },
          };
        }

        case "write": {
          if (!scopedSession) {
            return {
              content: [
                {
                  type: "text",
                  text: `No active session found for ${params.sessionId}`,
                },
              ],
              details: { status: "failed" },
            };
          }
          if (!scopedSession.backgrounded) {
            return {
              content: [
                {
                  type: "text",
                  text: `Session ${params.sessionId} is not backgrounded.`,
                },
              ],
              details: { status: "failed" },
            };
          }
          if (
            !scopedSession.child?.stdin ||
            scopedSession.child.stdin.destroyed
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: `Session ${params.sessionId} stdin is not writable.`,
                },
              ],
              details: { status: "failed" },
            };
          }
          await new Promise<void>((resolve, reject) => {
            scopedSession.child?.stdin.write(params.data ?? "", (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
          if (params.eof) {
            scopedSession.child.stdin.end();
          }
          return {
            content: [
              {
                type: "text",
                text: `Wrote ${(params.data ?? "").length} bytes to session ${
                  params.sessionId
                }${params.eof ? " (stdin closed)" : ""}.`,
              },
            ],
            details: {
              status: "running",
              sessionId: params.sessionId,
              name: scopedSession
                ? deriveSessionName(scopedSession.command)
                : undefined,
            },
          };
        }

        case "kill": {
          if (!scopedSession) {
            return {
              content: [
                {
                  type: "text",
                  text: `No active session found for ${params.sessionId}`,
                },
              ],
              details: { status: "failed" },
            };
          }
          if (!scopedSession.backgrounded) {
            return {
              content: [
                {
                  type: "text",
                  text: `Session ${params.sessionId} is not backgrounded.`,
                },
              ],
              details: { status: "failed" },
            };
          }
          killSession(scopedSession);
          markExited(scopedSession, null, "SIGKILL", "failed");
          return {
            content: [
              { type: "text", text: `Killed session ${params.sessionId}.` },
            ],
            details: {
              status: "failed",
              name: scopedSession
                ? deriveSessionName(scopedSession.command)
                : undefined,
            },
          };
        }

        case "clear": {
          if (scopedFinished) {
            deleteSession(params.sessionId);
            return {
              content: [
                { type: "text", text: `Cleared session ${params.sessionId}.` },
              ],
              details: { status: "completed" },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `No finished session found for ${params.sessionId}`,
              },
            ],
            details: { status: "failed" },
          };
        }

        case "remove": {
          if (scopedSession) {
            killSession(scopedSession);
            markExited(scopedSession, null, "SIGKILL", "failed");
            return {
              content: [
                { type: "text", text: `Removed session ${params.sessionId}.` },
              ],
              details: {
                status: "failed",
                name: scopedSession
                  ? deriveSessionName(scopedSession.command)
                  : undefined,
              },
            };
          }
          if (scopedFinished) {
            deleteSession(params.sessionId);
            return {
              content: [
                { type: "text", text: `Removed session ${params.sessionId}.` },
              ],
              details: { status: "completed" },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `No session found for ${params.sessionId}`,
              },
            ],
            details: { status: "failed" },
          };
        }
      }

      return {
        content: [
          { type: "text", text: `Unknown action ${params.action as string}` },
        ],
        details: { status: "failed" },
      };
    },
  };
}

export const processTool = createProcessTool();

function buildSandboxEnv(params: {
  paramsEnv?: Record<string, string>;
  sandboxEnv?: Record<string, string>;
  containerWorkdir: string;
}) {
  const env: Record<string, string> = {
    PATH: DEFAULT_PATH,
    HOME: params.containerWorkdir,
  };
  for (const [key, value] of Object.entries(params.sandboxEnv ?? {})) {
    env[key] = value;
  }
  for (const [key, value] of Object.entries(params.paramsEnv ?? {})) {
    env[key] = value;
  }
  return env;
}

function coerceEnv(env?: NodeJS.ProcessEnv | Record<string, string>) {
  const record: Record<string, string> = {};
  if (!env) return record;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") record[key] = value;
  }
  return record;
}

function buildDockerExecArgs(params: {
  containerName: string;
  command: string;
  workdir?: string;
  env: Record<string, string>;
  tty: boolean;
}) {
  const args = ["exec", "-i"];
  if (params.tty) args.push("-t");
  if (params.workdir) {
    args.push("-w", params.workdir);
  }
  for (const [key, value] of Object.entries(params.env)) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(params.containerName, "sh", "-lc", params.command);
  return args;
}

async function resolveSandboxWorkdir(params: {
  workdir: string;
  sandbox: BashSandboxConfig;
  warnings: string[];
}) {
  const fallback = params.sandbox.workspaceDir;
  try {
    const resolved = await assertSandboxPath({
      filePath: params.workdir,
      cwd: process.cwd(),
      root: params.sandbox.workspaceDir,
    });
    const stats = await fs.stat(resolved.resolved);
    if (!stats.isDirectory()) {
      throw new Error("workdir is not a directory");
    }
    const relative = resolved.relative
      ? resolved.relative.split(path.sep).join(path.posix.sep)
      : "";
    const containerWorkdir = relative
      ? path.posix.join(params.sandbox.containerWorkdir, relative)
      : params.sandbox.containerWorkdir;
    return { hostWorkdir: resolved.resolved, containerWorkdir };
  } catch {
    params.warnings.push(
      `Warning: workdir "${params.workdir}" is unavailable; using "${fallback}".`,
    );
    return {
      hostWorkdir: fallback,
      containerWorkdir: params.sandbox.containerWorkdir,
    };
  }
}

function killSession(session: {
  pid?: number;
  child?: ChildProcessWithoutNullStreams;
}) {
  const pid = session.pid ?? session.child?.pid;
  if (pid) {
    killProcessTree(pid);
  }
}

function resolveWorkdir(workdir: string, warnings: string[]) {
  const current = safeCwd();
  const fallback = current ?? homedir();
  try {
    const stats = statSync(workdir);
    if (stats.isDirectory()) return workdir;
  } catch {
    // ignore, fallback below
  }
  warnings.push(
    `Warning: workdir "${workdir}" is unavailable; using "${fallback}".`,
  );
  return fallback;
}

function safeCwd() {
  try {
    const cwd = process.cwd();
    return existsSync(cwd) ? cwd : null;
  } catch {
    return null;
  }
}

function clampNumber(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
) {
  if (value === undefined || Number.isNaN(value)) return defaultValue;
  return Math.min(Math.max(value, min), max);
}

function readEnvInt(key: string) {
  const raw = process.env[key];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function chunkString(input: string, limit = CHUNK_LIMIT) {
  const chunks: string[] = [];
  for (let i = 0; i < input.length; i += limit) {
    chunks.push(input.slice(i, i + limit));
  }
  return chunks;
}

function truncateMiddle(str: string, max: number) {
  if (str.length <= max) return str;
  const half = Math.floor((max - 3) / 2);
  return `${sliceUtf16Safe(str, 0, half)}...${sliceUtf16Safe(str, -half)}`;
}

function sliceLogLines(
  text: string,
  offset?: number,
  limit?: number,
): { slice: string; totalLines: number; totalChars: number } {
  if (!text) return { slice: "", totalLines: 0, totalChars: 0 };
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const totalLines = lines.length;
  const totalChars = text.length;
  let start =
    typeof offset === "number" && Number.isFinite(offset)
      ? Math.max(0, Math.floor(offset))
      : 0;
  if (limit !== undefined && offset === undefined) {
    const tailCount = Math.max(0, Math.floor(limit));
    start = Math.max(totalLines - tailCount, 0);
  }
  const end =
    typeof limit === "number" && Number.isFinite(limit)
      ? start + Math.max(0, Math.floor(limit))
      : undefined;
  return { slice: lines.slice(start, end).join("\n"), totalLines, totalChars };
}

function deriveSessionName(command: string): string | undefined {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) return undefined;
  const verb = tokens[0];
  let target = tokens.slice(1).find((t) => !t.startsWith("-"));
  if (!target) target = tokens[1];
  if (!target) return verb;
  const cleaned = truncateMiddle(stripQuotes(target), 48);
  return `${stripQuotes(verb)} ${cleaned}`;
}

function tokenizeCommand(command: string): string[] {
  const matches =
    command.match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')+/g) ?? [];
  return matches.map((token) => stripQuotes(token)).filter(Boolean);
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m${rem.toString().padStart(2, "0")}s`;
}

function pad(str: string, width: number) {
  if (str.length >= width) return str;
  return str + " ".repeat(width - str.length);
}
