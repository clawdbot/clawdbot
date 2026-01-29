import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

import { formatErrorMessage } from "../infra/errors.js";
import { runExec } from "../process/exec.js";

import {
  deleteSession,
  drainSession,
  getFinishedSession,
  getSession,
  listFinishedSessions,
  listRunningSessions,
  markExited,
  setJobTtlMs,
} from "./bash-process-registry.js";
import {
  deriveSessionName,
  formatDuration,
  killSession,
  pad,
  sliceLogLines,
  truncateMiddle,
} from "./bash-tools.shared.js";
import { encodeKeySequence, encodePaste } from "./pty-keys.js";

export type ProcessToolDefaults = {
  cleanupMs?: number;
  scopeKey?: string;
};

type SystemdUnitState = {
  activeState?: string;
  subState?: string;
};

async function systemdShowUserUnit(unit: string): Promise<SystemdUnitState | null> {
  try {
    const { stdout } = await runExec("systemctl", [
      "--user",
      "show",
      unit,
      "-p",
      "ActiveState",
      "-p",
      "SubState",
    ]);
    const out = stdout.trim();
    if (!out) return null;
    const lines = out.split("\n");
    const state: SystemdUnitState = {};
    for (const line of lines) {
      const [key, ...rest] = line.split("=");
      const value = rest.join("=").trim();
      if (key === "ActiveState") state.activeState = value;
      if (key === "SubState") state.subState = value;
    }
    return state;
  } catch (err) {
    const msg = formatErrorMessage(err).toLowerCase();
    if (msg.includes("could not be found") || msg.includes("not found")) {
      return null;
    }
    if (
      msg.includes("failed to connect to bus") ||
      msg.includes("systemctl not available") ||
      msg.includes("not been booted with systemd")
    ) {
      return null;
    }
    throw err;
  }
}

async function systemdJournalTail(unit: string, limit: number): Promise<string> {
  try {
    const { stdout, stderr } = await runExec("journalctl", [
      "--user",
      "-u",
      unit,
      "--no-pager",
      "-o",
      "cat",
      "-n",
      String(Math.max(1, Math.floor(limit))),
    ]);
    return (stdout || stderr).trimEnd();
  } catch (err) {
    return `journalctl failed: ${formatErrorMessage(err)}`.trim();
  }
}

async function systemdStopUserUnit(unit: string): Promise<void> {
  await runExec("systemctl", ["--user", "stop", unit]).catch(() => undefined);
}

const processSchema = Type.Object({
  action: Type.String({ description: "Process action" }),
  sessionId: Type.Optional(Type.String({ description: "Session id for actions other than list" })),
  data: Type.Optional(Type.String({ description: "Data to write for write" })),
  keys: Type.Optional(
    Type.Array(Type.String(), { description: "Key tokens to send for send-keys" }),
  ),
  hex: Type.Optional(Type.Array(Type.String(), { description: "Hex bytes to send for send-keys" })),
  literal: Type.Optional(Type.String({ description: "Literal string for send-keys" })),
  text: Type.Optional(Type.String({ description: "Text to paste for paste" })),
  bracketed: Type.Optional(Type.Boolean({ description: "Wrap paste in bracketed mode" })),
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
    description:
      "Manage running exec sessions: list, poll, log, write, send-keys, submit, paste, kill.",
    parameters: processSchema,
    execute: async (_toolCallId, args) => {
      const params = args as {
        action:
          | "list"
          | "poll"
          | "log"
          | "write"
          | "send-keys"
          | "submit"
          | "paste"
          | "kill"
          | "clear"
          | "remove";
        sessionId?: string;
        data?: string;
        keys?: string[];
        hex?: string[];
        literal?: string;
        text?: string;
        bracketed?: boolean;
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
            systemdUnit: s.systemdUnit ?? undefined,
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
            systemdUnit: s.systemdUnit ?? undefined,
          }));
        const lines = [...running, ...finished]
          .sort((a, b) => b.startedAt - a.startedAt)
          .map((s) => {
            const label = s.name ? truncateMiddle(s.name, 80) : truncateMiddle(s.command, 120);
            return `${s.sessionId} ${pad(s.status, 9)} ${formatDuration(s.runtimeMs)} :: ${label}`;
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
          content: [{ type: "text", text: "sessionId is required for this action." }],
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
                  status: scopedFinished.status === "completed" ? "completed" : "failed",
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

          if (scopedSession.systemdUnit) {
            const unit = scopedSession.systemdUnit;
            const state = await systemdShowUserUnit(unit);
            const output = await systemdJournalTail(unit, 200);
            const active = state?.activeState ?? "unknown";
            const sub = state?.subState ?? "unknown";
            const exited = state == null || (active !== "active" && active !== "activating");
            if (exited) {
              const failed = active === "failed" || sub === "failed";
              const status = failed ? "failed" : "completed";
              scopedSession.aggregated = output;
              scopedSession.tail = scopedSession.aggregated
                ? truncateMiddle(scopedSession.aggregated, 2000)
                : scopedSession.tail;
              markExited(scopedSession, failed ? 1 : 0, null, status);
              return {
                content: [
                  {
                    type: "text",
                    text:
                      (output || "(no output)") +
                      `\n\nsystemd unit exited (${unit}; state=${active}/${sub}).`,
                  },
                ],
                details: {
                  status: status === "completed" ? "completed" : "failed",
                  sessionId: params.sessionId,
                  exitCode: failed ? 1 : 0,
                  aggregated: output,
                  name: deriveSessionName(scopedSession.command),
                },
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text:
                    (output || "(no recent output)") +
                    `\n\nsystemd unit running (${unit}; state=${active}/${sub}).`,
                },
              ],
              details: {
                status: "running",
                sessionId: params.sessionId,
                aggregated: output,
                name: deriveSessionName(scopedSession.command),
              },
            };
          }

          const { stdout, stderr } = drainSession(scopedSession);
          const exited = scopedSession.exited;
          const exitCode = scopedSession.exitCode ?? 0;
          const exitSignal = scopedSession.exitSignal ?? undefined;
          if (exited) {
            const status = exitCode === 0 && exitSignal == null ? "completed" : "failed";
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
          const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n").trim();
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
            if (scopedSession.systemdUnit) {
              const unit = scopedSession.systemdUnit;
              const limit = typeof params.limit === "number" ? Math.floor(params.limit) : 200;
              const output = await systemdJournalTail(unit, limit);
              return {
                content: [{ type: "text", text: output || "(no output yet)" }],
                details: {
                  status: "running",
                  sessionId: params.sessionId,
                  aggregated: output,
                  name: deriveSessionName(scopedSession.command),
                },
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
            const status = scopedFinished.status === "completed" ? "completed" : "failed";
            return {
              content: [{ type: "text", text: slice || "(no output recorded)" }],
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
          if (scopedSession.systemdUnit) {
            return {
              content: [
                {
                  type: "text",
                  text: `Session ${params.sessionId} is managed by systemd (${scopedSession.systemdUnit}); stdin write is not supported.`,
                },
              ],
              details: { status: "failed" },
            };
          }
          const stdin = scopedSession.stdin ?? scopedSession.child?.stdin;
          if (!stdin || stdin.destroyed) {
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
            stdin.write(params.data ?? "", (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
          if (params.eof) {
            stdin.end();
          }
          return {
            content: [
              {
                type: "text",
                text: `Wrote ${(params.data ?? "").length} bytes to session ${params.sessionId}${
                  params.eof ? " (stdin closed)" : ""
                }.`,
              },
            ],
            details: {
              status: "running",
              sessionId: params.sessionId,
              name: scopedSession ? deriveSessionName(scopedSession.command) : undefined,
            },
          };
        }

        case "send-keys": {
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
          if (scopedSession.systemdUnit) {
            return {
              content: [
                {
                  type: "text",
                  text: `Session ${params.sessionId} is managed by systemd (${scopedSession.systemdUnit}); interactive input is not supported.`,
                },
              ],
              details: { status: "failed" },
            };
          }
          const stdin = scopedSession.stdin ?? scopedSession.child?.stdin;
          if (!stdin || stdin.destroyed) {
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
          const { data, warnings } = encodeKeySequence({
            keys: params.keys,
            hex: params.hex,
            literal: params.literal,
          });
          if (!data) {
            return {
              content: [
                {
                  type: "text",
                  text: "No key data provided.",
                },
              ],
              details: { status: "failed" },
            };
          }
          await new Promise<void>((resolve, reject) => {
            stdin.write(data, (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
          return {
            content: [
              {
                type: "text",
                text:
                  `Sent ${data.length} bytes to session ${params.sessionId}.` +
                  (warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : ""),
              },
            ],
            details: {
              status: "running",
              sessionId: params.sessionId,
              name: scopedSession ? deriveSessionName(scopedSession.command) : undefined,
            },
          };
        }

        case "submit": {
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
          if (scopedSession.systemdUnit) {
            return {
              content: [
                {
                  type: "text",
                  text: `Session ${params.sessionId} is managed by systemd (${scopedSession.systemdUnit}); interactive input is not supported.`,
                },
              ],
              details: { status: "failed" },
            };
          }
          const stdin = scopedSession.stdin ?? scopedSession.child?.stdin;
          if (!stdin || stdin.destroyed) {
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
            stdin.write("\r", (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
          return {
            content: [
              {
                type: "text",
                text: `Submitted session ${params.sessionId} (sent CR).`,
              },
            ],
            details: {
              status: "running",
              sessionId: params.sessionId,
              name: scopedSession ? deriveSessionName(scopedSession.command) : undefined,
            },
          };
        }

        case "paste": {
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
          if (scopedSession.systemdUnit) {
            return {
              content: [
                {
                  type: "text",
                  text: `Session ${params.sessionId} is managed by systemd (${scopedSession.systemdUnit}); interactive input is not supported.`,
                },
              ],
              details: { status: "failed" },
            };
          }
          const stdin = scopedSession.stdin ?? scopedSession.child?.stdin;
          if (!stdin || stdin.destroyed) {
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
          const payload = encodePaste(params.text ?? "", params.bracketed !== false);
          if (!payload) {
            return {
              content: [
                {
                  type: "text",
                  text: "No paste text provided.",
                },
              ],
              details: { status: "failed" },
            };
          }
          await new Promise<void>((resolve, reject) => {
            stdin.write(payload, (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
          return {
            content: [
              {
                type: "text",
                text: `Pasted ${params.text?.length ?? 0} chars to session ${params.sessionId}.`,
              },
            ],
            details: {
              status: "running",
              sessionId: params.sessionId,
              name: scopedSession ? deriveSessionName(scopedSession.command) : undefined,
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
          if (scopedSession.systemdUnit) {
            const unit = scopedSession.systemdUnit;
            await systemdStopUserUnit(unit);
            markExited(scopedSession, null, "SIGTERM", "killed");
            return {
              content: [
                {
                  type: "text",
                  text: `Stopped systemd unit ${unit} (session ${params.sessionId}).`,
                },
              ],
              details: {
                status: "completed",
                name: scopedSession ? deriveSessionName(scopedSession.command) : undefined,
              },
            };
          }
          killSession(scopedSession);
          markExited(scopedSession, null, "SIGKILL", "failed");
          return {
            content: [{ type: "text", text: `Killed session ${params.sessionId}.` }],
            details: {
              status: "failed",
              name: scopedSession ? deriveSessionName(scopedSession.command) : undefined,
            },
          };
        }

        case "clear": {
          if (scopedFinished) {
            deleteSession(params.sessionId);
            return {
              content: [{ type: "text", text: `Cleared session ${params.sessionId}.` }],
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
            if (scopedSession.systemdUnit) {
              const unit = scopedSession.systemdUnit;
              await systemdStopUserUnit(unit);
              markExited(scopedSession, null, "SIGTERM", "killed");
              return {
                content: [
                  {
                    type: "text",
                    text: `Removed systemd unit ${unit} (session ${params.sessionId}).`,
                  },
                ],
                details: {
                  status: "completed",
                  name: scopedSession ? deriveSessionName(scopedSession.command) : undefined,
                },
              };
            }
            killSession(scopedSession);
            markExited(scopedSession, null, "SIGKILL", "failed");
            return {
              content: [{ type: "text", text: `Removed session ${params.sessionId}.` }],
              details: {
                status: "failed",
                name: scopedSession ? deriveSessionName(scopedSession.command) : undefined,
              },
            };
          }
          if (scopedFinished) {
            deleteSession(params.sessionId);
            return {
              content: [{ type: "text", text: `Removed session ${params.sessionId}.` }],
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
        content: [{ type: "text", text: `Unknown action ${params.action as string}` }],
        details: { status: "failed" },
      };
    },
  };
}

export const processTool = createProcessTool();
