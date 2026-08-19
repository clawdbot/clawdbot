// Keeps fake-terminal test-only logs and opaque-session fixtures independently bounded.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TUI_PTY_ASSISTANT_FIXTURE_SCRIPT } from "./tui-pty-assistant-fixture-test-support.js";
import { TUI_PTY_GAP_HISTORY_FIXTURE_SCRIPT } from "./tui-pty-gap-fixture-test-support.js";
import {
  waitForFixtureLogEntry,
  type FixtureLogEntry,
} from "./tui-pty-harness-assertion-test-support.js";
import { TUI_PTY_RECONNECT_FIXTURE } from "./tui-pty-reconnect-fixture-test-support.js";
import { TUI_PTY_RENDERING_FIXTURE_SCRIPT } from "./tui-pty-rendering-test-support.js";
import { TUI_PTY_RESET_FIXTURE } from "./tui-pty-reset-fixture-test-support.js";
import { TUI_PTY_STARTUP_SESSION_FIXTURE } from "./tui-pty-startup-session-fixture-test-support.js";
import { TUI_PTY_SESSION_SUBSCRIPTION_FIXTURE_SCRIPT } from "./tui-pty-subscription-fixture-test-support.js";
import { startPty, type PtyRun } from "./tui-pty-test-support.js";

export * from "./tui-pty-harness-assertion-test-support.js";

const activeRuns: PtyRun[] = [];
const OUTPUT_TIMEOUT_MS = 2_000;
const EXIT_TIMEOUT_MS = 4_000;

export async function disposeActiveTuiFixtures(): Promise<void> {
  for (const run of activeRuns.splice(0)) {
    await run.dispose();
  }
}

export async function startTuiFixture(opts: { env?: NodeJS.ProcessEnv } = {}) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-tui-pty-"));
  const scriptPath = await writeTuiPtyFixtureScript(tempDir);
  const logPath = path.join(tempDir, "fixture-log.jsonl");
  const run = startPty(process.execPath, ["--import", "tsx", scriptPath], {
    activeRuns,
    cwd: process.cwd(),
    env: {
      OPENCLAW_THEME: "dark",
      OPENCLAW_TUI_PTY_LOG_PATH: logPath,
      NO_COLOR: undefined,
      ...opts.env,
    },
    exitTimeoutMs: EXIT_TIMEOUT_MS,
    outputTimeoutMs: OUTPUT_TIMEOUT_MS,
  });

  return {
    run,
    logPath,
    waitForLogEntry: async (predicate: (entry: FixtureLogEntry) => boolean, timeoutMs?: number) =>
      await waitForFixtureLogEntry(logPath, predicate, timeoutMs ?? OUTPUT_TIMEOUT_MS, run.output),
    cleanup: async () => {
      await run.dispose();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

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
      import { appendFileSync, existsSync, watch } from "node:fs";
      import { dirname } from "node:path";
      import { buildEmbeddedRunPayloads } from ${JSON.stringify(payloadsModuleUrl)};
      import { getReplyPayloadMetadata } from ${JSON.stringify(replyPayloadModuleUrl)};
      import { normalizeReplyPayloadsForDelivery } from ${JSON.stringify(outboundPayloadsModuleUrl)};
      import type { TuiBackend } from ${JSON.stringify(tuiModuleUrl.replace("/tui.ts", "/tui-backend.ts"))};
      import { runTui } from ${JSON.stringify(tuiModuleUrl)};

      const actionLogPath = process.env.OPENCLAW_TUI_PTY_LOG_PATH;
      const gatewayStatus = process.env.OPENCLAW_TUI_PTY_GATEWAY_STATUS ?? "fixture gateway ok";
      const startupDelayMs = Number(process.env.OPENCLAW_TUI_PTY_STARTUP_DELAY_MS ?? 0);
      ${TUI_PTY_STARTUP_SESSION_FIXTURE.variables}
      const footerModel = process.env.OPENCLAW_TUI_PTY_MODEL;
      const footerThinkingLevel = process.env.OPENCLAW_TUI_PTY_THINKING_LEVEL;
      let verboseLevel = process.env.OPENCLAW_TUI_PTY_VERBOSE_LEVEL;
      let modeTargetTraceLevel: string | undefined;
      const launchThinkingLevel = process.env.OPENCLAW_TUI_PTY_LAUNCH_THINKING;
      const initialMessage = process.env.OPENCLAW_TUI_PTY_INITIAL_MESSAGE;
      const inFlightRunText = process.env.OPENCLAW_TUI_PTY_IN_FLIGHT_TEXT;
      const dynamicCommandDescription = process.env.OPENCLAW_TUI_PTY_DYNAMIC_COMMAND_DESCRIPTION;
      const thinkingLabel = process.env.OPENCLAW_TUI_PTY_THINKING_LABEL;
      const safeThinkingLabel = process.env.OPENCLAW_TUI_PTY_SAFE_THINKING_LABEL;
      const liveReplyHistory: unknown[] = [];
      let liveReplySequence = 0;
      const thinkingLevels = [
        ...(thinkingLabel ? [{ id: "fixture-thinking", label: thinkingLabel }] : []),
        ...(safeThinkingLabel ? [{ id: "fixture-thinking-safe", label: safeThinkingLabel }] : []),
      ];
      ${TUI_PTY_RECONNECT_FIXTURE.variables}
      const enablePickerFixture = process.env.OPENCLAW_TUI_PTY_PICKER_FIXTURE === "1";
      const pickerModelValue = process.env.OPENCLAW_TUI_PTY_PICKER_MODEL_VALUE ?? "fixture-provider/fixture-model-2";
      const pickerModelName = process.env.OPENCLAW_TUI_PTY_PICKER_MODEL_NAME ?? "Fixture 2";
      const pickerSessionKey = process.env.OPENCLAW_TUI_PTY_PICKER_SESSION_KEY ?? "agent:main:picker-target";
      const pickerSessionTitle = process.env.OPENCLAW_TUI_PTY_PICKER_SESSION_TITLE;
      const pickerSessionPreview = process.env.OPENCLAW_TUI_PTY_PICKER_SESSION_PREVIEW;
      const pickerSessionDisplayName = process.env.OPENCLAW_TUI_PTY_PICKER_SESSION_DISPLAY_NAME ?? "Picker target";
      const initialPluginApprovalSessionKey = process.env.OPENCLAW_TUI_PTY_INITIAL_APPROVAL_SESSION_KEY;
      const xaiLimitError = '403 {"code":"The caller does not have permission to execute the specified operation","error":"Your team team-redacted has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}';
      let currentModel = footerModel ?? "fixture-provider/fixture-model";
      let currentThinkingLevel = footerThinkingLevel;
      let fastMode = process.env.OPENCLAW_TUI_PTY_FAST_MODE === "true";
      function pluginApproval(sessionKey: string) {
        return {
          id: "plugin:skill-pty",
          request: {
            title: "Apply workspace skill proposal",
            description: "Apply a pending workspace skill proposal into live workspace skills.",
            pluginId: "workspace-skills",
            severity: "warning" as const,
            toolName: "skill_workshop",
            allowedDecisions: ["allow-once", "deny"],
            sessionKey,
          },
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 120_000,
        };
      }
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
      } | null = initialPluginApprovalSessionKey
        ? pluginApproval(initialPluginApprovalSessionKey)
        : null;
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
        const isModeSource = key.endsWith(":mode-source");
        const isModeTarget = key.endsWith(":mode-target");
        const entryFastMode = isModeSource ? true : isModeTarget ? undefined : fastMode;
        const entryVerboseLevel = isModeSource ? "full" : isModeTarget ? undefined : verboseLevel;
        const entryTraceLevel = isModeSource ? "raw" : isModeTarget ? modeTargetTraceLevel : undefined;
        const entryReasoningLevel = isModeSource ? "stream" : undefined;
        return {
          key,
          displayName: key === pickerSessionKey ? pickerSessionDisplayName : "Main",
          model: currentModel,
          modelProvider: "fixture-provider",
          contextTokens: 128,
          ...(entryFastMode !== undefined ? { fastMode: entryFastMode } : {}),
          ...(currentThinkingLevel ? { thinkingLevel: currentThinkingLevel } : {}),
          ...(entryVerboseLevel ? { verboseLevel: entryVerboseLevel } : {}),
          ...(entryTraceLevel ? { traceLevel: entryTraceLevel } : {}),
          ...(entryReasoningLevel ? { reasoningLevel: entryReasoningLevel } : {}),
          thinkingLevels,
        };
      }

      ${TUI_PTY_GAP_HISTORY_FIXTURE_SCRIPT}
      ${TUI_PTY_ASSISTANT_FIXTURE_SCRIPT}
      ${TUI_PTY_RENDERING_FIXTURE_SCRIPT}

      class FixtureBackend implements TuiBackend {
        connection = { url: "pty-fixture://local" };
        onEvent?: TuiBackend["onEvent"];
        onConnected?: TuiBackend["onConnected"];
        onDisconnected?: TuiBackend["onDisconnected"];
        onGap?: TuiBackend["onGap"];

        ${TUI_PTY_RECONNECT_FIXTURE.disconnect}

        start() {
          if (pendingPluginApproval) {
            this.onEvent?.({ event: "plugin.approval.requested", payload: pendingPluginApproval });
          }
          queueMicrotask(() => this.onConnected?.());
        }

        stop() {
          record("stop");
        }

        ${TUI_PTY_SESSION_SUBSCRIPTION_FIXTURE_SCRIPT}

        async sendChat(opts: Parameters<TuiBackend["sendChat"]>[0]) {
          record("sendChat", opts);
          const runId = opts.runId ?? "run-pty-fixture";
          ${TUI_PTY_RECONNECT_FIXTURE.sendChat}
          if (opts.message.startsWith("live reply dedupe proof: ")) {
            const reply = opts.message.endsWith("first") ? "TUI_LIVE_FIRST" : "TUI_LIVE_SECOND";
            const userSequence = ++liveReplySequence;
            const assistantSequence = ++liveReplySequence;
            const userMessage = {
              role: "user",
              content: [{ type: "text", text: opts.message }],
              __openclaw: {
                id: "live-user-" + userSequence,
                idempotencyKey: runId + ":user",
                seq: userSequence,
              },
            };
            const assistantMessage = {
              role: "assistant",
              content: [{ type: "text", text: reply }],
              __openclaw: { id: "live-assistant-" + assistantSequence, seq: assistantSequence },
            };
            liveReplyHistory.push(userMessage, assistantMessage);
            queueMicrotask(() => {
              this.onEvent?.({
                event: "session.message",
                payload: {
                  sessionKey: opts.sessionKey,
                  message: userMessage,
                  messageId: userMessage.__openclaw.id,
                  messageSeq: userSequence,
                },
              });
              this.onEvent?.({
                event: "chat",
                payload: {
                  runId,
                  sessionKey: opts.sessionKey,
                  seq: assistantSequence,
                  state: "delta",
                  message: { role: "assistant", content: [{ type: "text", text: reply }] },
                },
              });
              this.onEvent?.({
                event: "chat",
                payload: {
                  runId,
                  sessionKey: opts.sessionKey,
                  seq: assistantSequence + 1,
                  state: "final",
                  message: { role: "assistant", content: [{ type: "text", text: reply }] },
                },
              });
              this.onEvent?.({
                event: "session.message",
                payload: {
                  sessionKey: opts.sessionKey,
                  message: assistantMessage,
                  messageId: assistantMessage.__openclaw.id,
                  messageSeq: assistantSequence,
                },
              });
              this.onEvent?.({
                event: "sessions.changed",
                payload: { sessionKey: opts.sessionKey, runId, phase: "end" },
              });
            });
            return { runId };
          }
          if (opts.message === "tui error redaction proof") {
            const escape = String.fromCharCode(27);
            throw new Error("gateway down", {
              cause: new Error(escape + "[31mAuthorization: Bearer sk-abcdefghijklmnopqrstuv" + escape + "[0m"),
            });
          }
          if (startRenderingFixture(this, opts.message, runId, opts.sessionKey)) return { runId };
          if (opts.message === "/btw picker focus proof") {
            queueMicrotask(() => {
              record("pickerSideResult", { runId, sessionKey: opts.sessionKey });
              this.onEvent?.({
                event: "chat.side_result",
                payload: {
                  kind: "btw",
                  runId,
                  sessionKey: opts.sessionKey,
                  question: process.env.OPENCLAW_TUI_PTY_BTW_QUESTION ?? "picker focus proof",
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
          if (opts.message === "history gap proof") { return beginGapHistoryRecovery(this, runId, opts.sessionKey); }
          if (opts.message === "skill approval proof" || opts.message === "skill approval gap proof") {
            pendingPluginApproval = pluginApproval(opts.sessionKey);
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
                  lastAssistant: undefined,
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
            const attachmentOnlyMessage = buildAttachmentOnlyAssistantMessage(opts.message, runId);
            const message = isSourceReplyProof
              ? assistantMessageFromSourceReplyPayloads(sourceReplyPayloads)
              : (attachmentOnlyMessage ?? {
                  role: "assistant",
                  content: [{ type: "text", text: "PTY_RESPONSE: " + opts.message }],
                  timestamp: Date.now(),
                });
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
          const gapHistory = loadGapHistory(sessionKey);
          if (gapHistory) { return gapHistory; }
          ${TUI_PTY_RECONNECT_FIXTURE.loadHistory}
          ${TUI_PTY_STARTUP_SESSION_FIXTURE.loadHistory}
          if (liveReplyHistory.length > 0) {
            return { messages: [...liveReplyHistory] };
          }
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
          const includeSessionInfo =
            Boolean(footerModel) || sessionKey.endsWith(":mode-source") || sessionKey.endsWith(":mode-target");
          return {
            messages: [],
            fastMode,
            ...(inFlightRunText
              ? { inFlightRun: { runId: "run-restored-in-flight", text: inFlightRunText } }
              : {}),
            ...(includeSessionInfo
              ? {
                  thinkingLevel: footerThinkingLevel,
                  sessionInfo: sessionEntry(sessionKey),
                }
              : {}),
          };
        }

        async listSessions(opts?: Parameters<TuiBackend["listSessions"]>[0]) {
          ${TUI_PTY_STARTUP_SESSION_FIXTURE.listSessionsSetup}
          record("listSessions", {
            ...opts,
            purpose: opts?.includeDerivedTitles ? "picker" : "refresh",
          });
          ${TUI_PTY_STARTUP_SESSION_FIXTURE.listSessionsDelay}
          const sessions = enablePickerFixture
            ? [
                sessionEntry("main"),
                {
                  ...sessionEntry(pickerSessionKey),
                  derivedTitle: pickerSessionTitle,
                  lastMessagePreview: pickerSessionPreview,
                },
              ]
            : [];
          const visibleSessions = sessions.filter(
            (session) => session.key !== "global" || opts?.includeGlobal === true,
          );
          return {
            ts: Date.now(),
            path: "",
            count: visibleSessions.length,
            sessions: visibleSessions,
            defaults: {
              model: currentModel,
              modelProvider: "fixture-provider",
              contextTokens: 128,
              thinkingLevels,
            },
          };
        }

        async listAgents() {
          return {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "main", name: enablePickerFixture ? pickerSessionDisplayName : "Main" }],
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
          if (typeof opts.traceLevel === "string" && opts.key.endsWith(":mode-target")) {
            modeTargetTraceLevel = opts.traceLevel;
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

        ${TUI_PTY_RESET_FIXTURE.methods}

        async getGatewayStatus() {
          record("getGatewayStatus");
          this.reconnectSessionSubscription();
          this.emitDisconnect();
          return gatewayStatus;
        }

        async listModels() {
          record("listModels");
          return [
            { id: "fixture-provider/fixture-model", name: "Fixture", provider: "fixture-provider" },
            { id: pickerModelValue, name: pickerModelName, provider: "fixture-provider" },
          ];
        }

        async listCommands() {
          record("listCommands");
          return dynamicCommandDescription
            ? [{
                name: "t08dynamic",
                textAliases: ["/t08dynamic"],
                description: dynamicCommandDescription,
                source: "plugin" as const,
                scope: "text" as const,
                acceptsArgs: false,
              }]
            : [];
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
          deliver: process.env.OPENCLAW_TUI_PTY_DELIVER === "1",
          session: process.env.OPENCLAW_TUI_PTY_SESSION,
          thinking: launchThinkingLevel,
          message: initialMessage,
          historyLimit: 5,
          title: "openclaw tui pty fixture",
          ${TUI_PTY_RESET_FIXTURE.options}
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
