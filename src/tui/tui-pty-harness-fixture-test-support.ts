// Keeps fake-terminal test-only logs and opaque-session fixtures independently bounded.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sleep, type PtyRun } from "./tui-pty-test-support.js";

export async function writeTuiPtyFixtureScript(dir: string) {
  // Temp files sit outside the repo package scope; .mts preserves the ESM contract under tsx.
  const scriptPath = path.join(dir, "run-tui-pty-fixture.mts");
  const tuiModuleUrl = pathToFileURL(path.join(process.cwd(), "src/tui/tui.ts")).href;
  const payloadsModuleUrl = pathToFileURL(
    path.join(process.cwd(), "src/agents/embedded-agent-runner/run/payloads.ts"),
  ).href;
  const replyPayloadModuleUrl = pathToFileURL(
    path.join(process.cwd(), "src/auto-reply/reply-payload.ts"),
  ).href;
  const outboundPayloadsModuleUrl = pathToFileURL(
    path.join(process.cwd(), "src/infra/outbound/payloads.ts"),
  ).href;
  await writeFile(
    scriptPath,
    `
      import { appendFileSync } from "node:fs";
      import { buildEmbeddedRunPayloads } from ${JSON.stringify(payloadsModuleUrl)};
      import { getReplyPayloadMetadata } from ${JSON.stringify(replyPayloadModuleUrl)};
      import { normalizeReplyPayloadsForDelivery } from ${JSON.stringify(outboundPayloadsModuleUrl)};
      import type { TuiBackend } from ${JSON.stringify(tuiModuleUrl.replace("/tui.ts", "/tui-backend.ts"))};
      import { runTui } from ${JSON.stringify(tuiModuleUrl)};

      const actionLogPath = process.env.OPENCLAW_TUI_PTY_LOG_PATH;
      const gatewayStatus = process.env.OPENCLAW_TUI_PTY_GATEWAY_STATUS ?? "fixture gateway ok";
      const startupDelayMs = Number(process.env.OPENCLAW_TUI_PTY_STARTUP_DELAY_MS ?? 0);
      const footerModel = process.env.OPENCLAW_TUI_PTY_MODEL;
      const footerThinkingLevel = process.env.OPENCLAW_TUI_PTY_THINKING_LEVEL;
      let verboseLevel = process.env.OPENCLAW_TUI_PTY_VERBOSE_LEVEL;
      const launchThinkingLevel = process.env.OPENCLAW_TUI_PTY_LAUNCH_THINKING;
      const initialMessage = process.env.OPENCLAW_TUI_PTY_INITIAL_MESSAGE;
      const enablePickerFixture = process.env.OPENCLAW_TUI_PTY_PICKER_FIXTURE === "1";
      const xaiLimitError = '403 {"code":"The caller does not have permission to execute the specified operation","error":"Your team team-redacted has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}';
      let currentModel = footerModel ?? "fixture-provider/fixture-model";
      let currentThinkingLevel = footerThinkingLevel;
      let fastMode = process.env.OPENCLAW_TUI_PTY_FAST_MODE === "true";
      let pendingPluginApproval: {
        id: string;
        request: {
          title: string;
          description: string;
          toolName: string;
          allowedDecisions: string[];
          sessionKey: string;
        };
        createdAtMs: number;
        expiresAtMs: number;
      } | null = null;
      let pendingPluginApprovalRun: { runId: string; sessionKey: string } | null = null;
      let pendingTaskSuggestion: {
        id: string;
        title: string;
        prompt: string;
        tldr: string;
        cwd: string;
        sessionKey: string;
        agentId: string;
        createdAt: number;
      } | null = null;

      function record(method: string, payload?: unknown) {
        if (!actionLogPath) {
          return;
        }
        appendFileSync(actionLogPath, JSON.stringify({ method, payload }) + "\\n", "utf8");
      }

      function sessionEntry(key = "main") {
        return {
          key,
          displayName: "Main",
          model: currentModel,
          modelProvider: "fixture-provider",
          contextTokens: 128,
          fastMode,
          ...(currentThinkingLevel ? { thinkingLevel: currentThinkingLevel } : {}),
          ...(verboseLevel ? { verboseLevel } : {}),
          thinkingLevels: [],
        };
      }

      function assistantMessageFromSourceReplyPayloads(payloads: ReturnType<typeof buildEmbeddedRunPayloads>) {
        if (payloads.length === 0) {
          throw new Error("expected source reply payload");
        }
        for (const payload of payloads) {
          const metadata = getReplyPayloadMetadata(payload);
          if (!metadata?.sourceReplyTranscriptMirror) {
            throw new Error("expected source reply transcript mirror metadata");
          }
          record("sourceReplyMetadata", metadata.sourceReplyTranscriptMirror);
        }
        const normalized = normalizeReplyPayloadsForDelivery(payloads);
        const content = normalized.flatMap((payload) => {
          const text = payload.text?.trim();
          return text ? [{ type: "text", text }] : [];
        });
        if (content.length === 0) {
          throw new Error("expected displayable source reply content");
        }
        return {
          role: "assistant",
          content,
          timestamp: Date.now(),
        };
      }

      class FixtureBackend implements TuiBackend {
        connection = { url: "pty-fixture://local" };
        onEvent?: TuiBackend["onEvent"];
        onConnected?: TuiBackend["onConnected"];
        onDisconnected?: TuiBackend["onDisconnected"];
        onGap?: TuiBackend["onGap"];

        start() {
          queueMicrotask(() => this.onConnected?.());
        }

        stop() {
          record("stop");
        }

        async sendChat(opts: Parameters<TuiBackend["sendChat"]>[0]) {
          record("sendChat", {
            sessionKey: opts.sessionKey,
            message: opts.message,
            deliver: opts.deliver,
            thinking: opts.thinking,
          });
          const runId = opts.runId ?? "run-pty-fixture";
          if (opts.message === "tui error redaction proof") {
            const escape = String.fromCharCode(27);
            throw new Error("gateway down", {
              cause: new Error(escape + "[31mAuthorization: Bearer sk-abcdefghijklmnopqrstuv" + escape + "[0m"),
            });
          }
          if (opts.message === "tool chronology proof") {
            setTimeout(() => {
              const emitAssistant = (state, text) => {
                const message = {
                  role: "assistant",
                  content: [{ type: "text", text }],
                  timestamp: Date.now(),
                };
                this.onEvent?.({ event: "chat", payload: { runId, sessionKey: opts.sessionKey, state, message } });
              };
              emitAssistant("delta", "PTY_BEFORE_TOOL");
              const data = {
                phase: "start",
                toolCallId: "pty-chronology-tool",
                name: "read_file",
                args: { path: "chronology-proof.txt" },
              };
              this.onEvent?.({ event: "agent", payload: { runId, sessionKey: opts.sessionKey, stream: "tool", data } });
              const completeText = "PTY_BEFORE_TOOL\\n\\nPTY_AFTER_TOOL";
              emitAssistant("delta", completeText);
              emitAssistant("final", completeText);
              record("toolChronologyComplete", { runId });
            }, 0);
            return { runId };
          }
          if (opts.message === "/btw picker focus proof") {
            queueMicrotask(() => {
              record("pickerSideResult", { runId, sessionKey: opts.sessionKey });
              this.onEvent?.({
                event: "chat.side_result",
                payload: {
                  kind: "btw",
                  runId,
                  sessionKey: opts.sessionKey,
                  question: "picker focus proof",
                  text: "PTY_SIDE_OK",
                },
              });
              this.onEvent?.({
                event: "chat",
                payload: { runId, sessionKey: opts.sessionKey, state: "final" },
              });
            });
            return { runId };
          }
          if (opts.message === "cross-session abort source proof") {
            for (const [delayMs, state, text] of [
              [100, "delta", "PTY_LATE_FOREIGN_DELTA"],
              [130, "final", "PTY_LATE_FOREIGN_FINAL"],
            ] as const) {
              setTimeout(() => {
                record("lateSessionEvent", { sessionKey: opts.sessionKey, state });
                this.onEvent?.({
                  event: "chat",
                  payload: {
                    runId,
                    sessionKey: opts.sessionKey,
                    state,
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text }],
                      timestamp: Date.now(),
                    },
                  },
                });
              }, delayMs);
            }
            return { runId };
          }
          if (opts.message === "burst streaming proof") {
            const tokens = Array.from({ length: 128 }, (_, index) =>
              "T" + String(index).padStart(3, "0"),
            );
            setTimeout(() => {
              for (let index = 0; index < tokens.length; index += 1) {
                this.onEvent?.({
                  event: "chat",
                  payload: {
                    runId,
                    sessionKey: opts.sessionKey,
                    state: "delta",
                    message: {
                      role: "assistant",
                      content: [
                        {
                          type: "text",
                          text: "PTY_STREAM_BURST: " + tokens.slice(0, index + 1).join(" "),
                        },
                      ],
                      timestamp: Date.now(),
                    },
                  },
                });
              }
              this.onEvent?.({
                event: "chat",
                payload: {
                  runId,
                  sessionKey: opts.sessionKey,
                  state: "final",
                  message: {
                    role: "assistant",
                    content: [
                      { type: "text", text: "PTY_STREAM_BURST: " + tokens.join(" ") },
                    ],
                    timestamp: Date.now(),
                  },
                },
              });
              record("streamBurstComplete", { count: tokens.length });
            }, 0);
            return { runId };
          }
          if (opts.message === "skill approval proof" || opts.message === "skill approval gap proof") {
            pendingPluginApproval = {
              id: "plugin:skill-pty",
              request: {
                title: "Apply workspace skill proposal",
                description: "Apply a pending workspace skill proposal into live workspace skills.",
                pluginId: "workspace-skills",
                severity: "warning",
                toolName: "skill_workshop",
                allowedDecisions: ["allow-once", "deny"],
                sessionKey: opts.sessionKey,
              },
              createdAtMs: Date.now(),
              expiresAtMs: Date.now() + 120_000,
            };
            pendingPluginApprovalRun = { runId, sessionKey: opts.sessionKey };
            queueMicrotask(() => {
              if (opts.message === "skill approval gap proof") {
                this.onGap?.({ expected: 4, received: 5 });
              } else {
                this.onEvent?.({
                  event: "plugin.approval.requested",
                  payload: pendingPluginApproval,
                });
              }
            });
            return { runId };
          }
          if (opts.message === "task suggestion proof") {
            pendingTaskSuggestion = {
              id: "task_pty",
              title: "Remove stale adapter",
              prompt: "Delete the stale adapter and update its tests.",
              tldr: "The adapter is unreachable and adds maintenance cost.",
              cwd: "/repo/project",
              sessionKey: opts.sessionKey,
              agentId: "main",
              createdAt: Date.now(),
            };
            queueMicrotask(() => {
              this.onEvent?.({
                event: "task.suggestion",
                payload: { action: "created", suggestion: pendingTaskSuggestion },
              });
            });
            return { runId };
          }
          ${buildOpaqueSessionIsolationFixture()}
          const responseDelayMs =
            opts.message === "slow prompt" ||
            opts.message === "slow reset proof" ||
            opts.message === "streaming prompt"
              ? 500
              : 20;
          if (opts.message === "streaming prompt") {
            setTimeout(() => {
              this.onEvent?.({
                event: "chat",
                payload: {
                  runId,
                  sessionKey: opts.sessionKey,
                  state: "delta",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "PTY_STREAMING: streaming prompt" }],
                    timestamp: Date.now(),
                  },
                },
              });
            }, 5);
          }
          const isSourceReplyProof = opts.message === "message tool only source reply proof";
          const isXaiLimitProof = opts.message === "xai limit proof";
          setTimeout(() => {
            if (isXaiLimitProof) {
              this.onEvent?.({
                event: "chat",
                payload: {
                  runId,
                  sessionKey: opts.sessionKey,
                  state: "error",
                  errorMessage: xaiLimitError,
                },
              });
              return;
            }
            const sourceReplyPayloads = isSourceReplyProof
              ? buildEmbeddedRunPayloads({
                  assistantTexts: [],
                  toolMetas: [],
                  lastAssistant: undefined,
                  inlineToolResultsAllowed: false,
                  sessionKey: opts.sessionKey,
                  sourceReplyDeliveryMode: "message_tool_only",
                  messagingToolSourceReplyPayloads: [
                    {
                      text: "VISIBLE_TUI_SOURCE_REPLY_PROOF",
                    },
                  ],
                  runId,
                })
              : [];
            const message = isSourceReplyProof
              ? assistantMessageFromSourceReplyPayloads(sourceReplyPayloads)
              : {
                  role: "assistant",
                  content: [{ type: "text", text: "PTY_RESPONSE: " + opts.message }],
                  timestamp: Date.now(),
                };
            this.onEvent?.({
              event: "chat",
              payload: {
                runId,
                sessionKey: opts.sessionKey,
                state: "final",
                message,
              },
            });
          }, responseDelayMs);
          return { runId };
        }

        async abortChat(opts: Parameters<TuiBackend["abortChat"]>[0]) {
          record("abortChat", opts);
          if (opts.sessionKey.endsWith(":abort-source")) {
            await new Promise((resolve) => setTimeout(resolve, 80));
            record("abortResolved", { sessionKey: opts.sessionKey });
          }
          return { ok: true, aborted: true };
        }

        async loadHistory(opts: Parameters<TuiBackend["loadHistory"]>[0]) {
          const sessionKey = opts?.sessionKey ?? "main";
          record("loadHistory", { sessionKey });
          const rapidSwitchMarker = sessionKey.endsWith("switch-a")
            ? "A"
            : sessionKey.endsWith("switch-b")
              ? "B"
              : null;
          const delayMs =
            rapidSwitchMarker === "A" ? 500 : rapidSwitchMarker === "B" ? 40 : startupDelayMs;
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          if (rapidSwitchMarker) {
            record("loadHistoryResolved", { sessionKey });
            return {
              sessionId: "session-" + rapidSwitchMarker,
              sessionInfo: {
                key: sessionKey,
                sessionId: "session-" + rapidSwitchMarker,
                model: currentModel,
                modelProvider: "fixture-provider",
                contextTokens: 128,
                fastMode,
                thinkingLevels: [],
              },
              messages: [{ role: "user", content: rapidSwitchMarker + "_HISTORY_MARKER" }],
            };
          }
          return {
            messages: [],
            fastMode,
            ...(footerModel
              ? {
                  thinkingLevel: footerThinkingLevel,
                  sessionInfo: sessionEntry(sessionKey),
                }
              : {}),
          };
        }

        async listSessions(opts?: Parameters<TuiBackend["listSessions"]>[0]) {
          record("listSessions", {
            purpose: opts?.includeDerivedTitles ? "picker" : "refresh",
          });
          const sessions = enablePickerFixture
            ? [sessionEntry("main"), { ...sessionEntry("agent:main:picker-target"), displayName: "Picker target" }]
            : [];
          return {
            ts: Date.now(),
            path: "",
            count: sessions.length,
            sessions,
            defaults: {
              model: currentModel,
              modelProvider: "fixture-provider",
              contextTokens: 128,
              thinkingLevels: [],
            },
          };
        }

        async listAgents() {
          return {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "main", name: "Main" }],
          };
        }

        async patchSession(opts: Parameters<TuiBackend["patchSession"]>[0]) {
          record("patchSession", opts);
          if (opts.model) {
            currentModel = opts.model;
          }
          if (opts.thinkingLevel) {
            currentThinkingLevel = opts.thinkingLevel;
          }
          if (typeof opts.fastMode === "boolean") {
            fastMode = opts.fastMode;
          }
          if (typeof opts.verboseLevel === "string") {
            verboseLevel = opts.verboseLevel;
          }
          return {
            ok: true,
            path: "",
            key: opts.key,
            entry: sessionEntry(opts.key),
            resolved: {
              modelProvider: "fixture-provider",
              model: currentModel,
            },
          };
        }

        async createSession(opts: Parameters<TuiBackend["createSession"]>[0]) {
          record("createSession", opts);
          const key = "agent:main:" + opts.key;
          return { ok: true, key, entry: { ...sessionEntry(key), sessionId: "created-session" } };
        }

        async resetSession(key: string, reason?: "new" | "reset") {
          record("resetSession", { key, reason });
          return {};
        }

        async getGatewayStatus() {
          record("getGatewayStatus");
          return gatewayStatus;
        }

        async listModels() {
          record("listModels");
          return [
            { id: "fixture-provider/fixture-model", name: "Fixture", provider: "fixture-provider" },
            { id: "fixture-provider/fixture-model-2", name: "Fixture 2", provider: "fixture-provider" },
          ];
        }

        async listPluginApprovals() {
          record("listPluginApprovals", { pending: Boolean(pendingPluginApproval) });
          return pendingPluginApproval ? [pendingPluginApproval] : [];
        }

        async resolvePluginApproval(id: string, decision: "allow-once" | "allow-always" | "deny") {
          record("resolvePluginApproval", { id, decision });
          const pendingRun = pendingPluginApprovalRun;
          pendingPluginApproval = null;
          pendingPluginApprovalRun = null;
          this.onEvent?.({
            event: "plugin.approval.resolved",
            payload: { id, decision },
          });
          this.onEvent?.({
            event: "chat",
            payload: {
              runId: pendingRun?.runId ?? "run-pty-fixture",
              sessionKey: pendingRun?.sessionKey ?? "agent:main:main",
              state: "final",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "PTY_SKILL_APPROVAL_RESOLVED: " + decision }],
                timestamp: Date.now(),
              },
            },
          });
          return { ok: true };
        }

        async listTaskSuggestions() {
          record("listTaskSuggestions", { pending: Boolean(pendingTaskSuggestion) });
          return pendingTaskSuggestion ? [pendingTaskSuggestion] : [];
        }

        async acceptTaskSuggestion(taskId: string) {
          record("acceptTaskSuggestion", { taskId });
          pendingTaskSuggestion = null;
          this.onEvent?.({
            event: "task.suggestion",
            payload: { action: "resolved", taskId, resolution: "accepted" },
          });
          return { taskId, key: "agent:main:task-pty" };
        }

        async dismissTaskSuggestion(taskId: string) {
          record("dismissTaskSuggestion", { taskId });
          pendingTaskSuggestion = null;
          this.onEvent?.({
            event: "task.suggestion",
            payload: { action: "resolved", taskId, resolution: "dismissed" },
          });
          return { taskId, dismissed: true };
        }
      }

      async function main() {
        await runTui({
          backend: new FixtureBackend(),
          config: {
            agents: {
              defaults: { model: "fixture-provider/fixture-model" },
              entries: { main: { default: true } },
            },
            session: { scope: "per-sender", mainKey: "main" },
          },
          deliver: false,
          thinking: launchThinkingLevel,
          message: initialMessage,
          historyLimit: 5,
          title: "openclaw tui pty fixture",
        });
      }

      main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `,
    "utf8",
  );
  return scriptPath;
}

export type FixtureLogEntry = {
  method: string;
  payload?: unknown;
};

export const COMPACT_TERMINAL_SIZES = [
  [64, 18],
  [68, 18],
  [72, 20],
  [80, 20],
] as const;

export async function readFixtureLog(logPath: string): Promise<FixtureLogEntry[]> {
  try {
    const text = await readFile(logPath, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FixtureLogEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function waitForFixtureLogEntry(
  logPath: string,
  predicate: (entry: FixtureLogEntry) => boolean,
  timeoutMs: number,
  readPtyOutput?: () => string,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const entries = await readFixtureLog(logPath);
    const match = entries.find(predicate);
    if (match) {
      return match;
    }
    await sleep(25);
  }
  const entries = await readFixtureLog(logPath);
  // A swallowed command leaves no RPC; its visible rejection survives only in the terminal.
  const ptyOutput = readPtyOutput?.() ?? "";
  throw new Error(
    `timed out waiting for fixture log entry\n${JSON.stringify(entries, null, 2)}\n${ptyOutput}`,
  );
}

export function objectFieldEquals(entry: FixtureLogEntry, field: string, value: unknown) {
  if (typeof entry.payload !== "object" || entry.payload === null) {
    return false;
  }
  const payload = entry.payload as Record<string, unknown>;
  return Object.hasOwn(payload, field) && payload[field] === value;
}

/** Proves fixture-local fragmentation preserves a Unicode prompt through the real TUI loop. */
export async function exerciseFragmentedUnicodePrompt(
  startFixture: (opts: { env?: NodeJS.ProcessEnv }) => Promise<{
    run: PtyRun;
    waitForLogEntry: (predicate: (entry: FixtureLogEntry) => boolean) => Promise<FixtureLogEntry>;
    cleanup: () => Promise<void>;
  }>,
  startupTimeoutMs: number,
) {
  const fixture = await startFixture({
    env: { OPENCLAW_TUI_PTY_TYPE_CHUNK_SIZE: "1", OPENCLAW_TUI_PTY_TYPE_DELAY_MS: "1" },
  });
  const message = "hello 👋 from pty";

  try {
    await fixture.run.waitForOutput("local ready", startupTimeoutMs);
    await fixture.run.write(`${message}\r`);
    await fixture.run.waitForOutput(`PTY_RESPONSE: ${message}`);
    await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", message),
    );
  } finally {
    await fixture.cleanup();
  }
}

/** Approves a workspace skill using exact fragments that survive narrow-terminal wrapping. */
export async function approveWorkspaceSkill(
  fixture: {
    run: PtyRun;
    waitForLogEntry: (predicate: (entry: FixtureLogEntry) => boolean) => Promise<FixtureLogEntry>;
  },
  message: string,
) {
  await fixture.run.write(`${message}\r`);
  await fixture.run.waitForOutput("workspace skill approval: Apply workspace skill proposal");
  await fixture.run.waitForOutput("Plugin: workspace-skills");
  // A compact PTY wraps the request; exact fragments avoid matching across terminal redraws.
  await fixture.run.waitForOutput("Apply a pending workspace skill proposal");
  await fixture.run.waitForOutput("into live workspace");
  await fixture.run.waitForOutput("skills.");

  await fixture.run.write("\x1b[A", { delay: false });
  await fixture.run.write("\r");
  await fixture.waitForLogEntry(
    (entry) =>
      entry.method === "resolvePluginApproval" &&
      objectFieldEquals(entry, "decision", "allow-once"),
  );
  await fixture.run.waitForOutput("PTY_SKILL_APPROVAL_RESOLVED: allow-once");
}

function buildOpaqueSessionIsolationFixture(): string {
  return `
          if (opts.message.startsWith("opaque session isolation proof: ")) {
            const otherSessionKey = opts.sessionKey.includes(":matrix:")
              ? opts.sessionKey.replace("!MixedRoomAbCdEf", "!mixedroomabcdef")
              : opts.sessionKey.replace("AbC123=", "abc123=");
            const marker = "PTY_FOREIGN_OPAQUE_SESSION_MESSAGE";
            queueMicrotask(() => {
              record("foreignSessionEvent", { sessionKey: otherSessionKey, marker });
              this.onEvent?.({
                event: "chat",
                payload: {
                  runId: "run-foreign-opaque-session",
                  sessionKey: otherSessionKey,
                  state: "delta",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: marker }],
                  },
                },
              });
              this.onEvent?.({
                event: "session.message",
                payload: {
                  agentId: "main",
                  sessionKey: otherSessionKey,
                  sessionId: "foreign-opaque-session",
                  updatedAt: Date.now(),
                },
              });
            });
          }
  `;
}
