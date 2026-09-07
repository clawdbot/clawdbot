import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../agents/admitted-run-context.js";
import { waitForSessionMaintenance } from "../../agents/session-maintenance/coordinator.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildRestartSafeChatTranscriptState,
  createRestartSafeChatRequest,
  resolveRestartSafeChatAdmission,
} from "../../gateway/server-methods/chat-restart-recovery.js";
import { clearMemoryPluginState, registerMemoryCapability } from "../../plugins/memory-state.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runReplyAgent } from "./agent-runner.js";
import {
  createTestFollowupRun,
  isModelRuntimeContextCarrier,
} from "./agent-runner.test-fixtures.js";
import { createTypingController } from "./typing.js";

type ModelRequest = {
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools?: Array<{ function?: { name?: string } }>;
};
const providerText = (content: unknown) =>
  extractTextFromChatContent(content, { joinWith: "\n", normalizeText: (text) => text }) ?? "";

describe("required maintenance with restart-safe admitted input", () => {
  it.each(["one archive", "two archives"] as const)(
    "keeps the approved user current through preflight maintenance (%s)",
    async (history) => {
      await withOpenClawTestState({ label: "required-maintenance-pending" }, async (state) => {
        const requests: ModelRequest[] = [];
        const approved =
          "Approved current request: preserve ünicode 🦞 and exact newlines.\n" +
          "Current background information.\n".repeat(1_600) +
          "Keep the current request active.";
        let observeForeground: (() => void) | undefined;
        const foregroundRequests: ModelRequest[] = [];
        const checkpointRequests: ModelRequest[] = [];
        const checkpointText = "# Durable checkpoint\nArchive policy preserved.\n";
        let advertisedWrite = false;
        const server = createServer((request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
          });
          request.on("end", () => {
            requests.push(JSON.parse(body) as ModelRequest);
            const received = requests.at(-1)!;
            const lastUser = received.messages.findLast(
              (message) => message.role === "user" && !isModelRuntimeContextCarrier(message),
            );
            const lastUserText = providerText(lastUser?.content);
            const foreground = lastUserText.endsWith(approved);
            const activeInstructions = [
              lastUserText,
              ...received.messages
                .filter((message) => message.role === "system" || message.role === "developer")
                .map((message) => providerText(message.content)),
            ].join("\n");
            // Runtime-only tasks carry instructions in the system message. A
            // compactor can quote the same words but does not advertise write.
            const checkpoint =
              !foreground &&
              activeInstructions.includes("Checkpoint durable notes.") &&
              received.tools?.some((tool) => tool.function?.name === "write") === true;
            if (checkpoint) {
              checkpointRequests.push(received);
            }
            const writeCheckpoint = checkpoint && checkpointRequests.length === 1;
            if (writeCheckpoint) {
              advertisedWrite =
                received.tools?.some((tool) => tool.function?.name === "write") === true;
              if (!advertisedWrite) {
                response.writeHead(500, { "content-type": "application/json" });
                response.end(
                  JSON.stringify({
                    error: { message: "Checkpoint write tool was not advertised" },
                  }),
                );
                return;
              }
            }
            if (foreground) {
              foregroundRequests.push(received);
              observeForeground?.();
            }
            const text = foreground
              ? "FOREGROUND_READY"
              : checkpoint
                ? "NO_REPLY"
                : "## Decisions\nKeep documentation clear.\n## Open TODOs\nRespond to the current user.\n## Constraints/Rules\nPreserve approved input.\n## Pending user asks\nContinue the current task.\n## Exact identifiers\narchive-marker";
            response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
            response.write(
              `data: ${JSON.stringify({
                id: "synthetic-completion",
                object: "chat.completion.chunk",
                created: 1,
                model: "test-model",
                choices: [
                  {
                    index: 0,
                    delta: writeCheckpoint
                      ? {
                          role: "assistant",
                          tool_calls: [
                            {
                              index: 0,
                              id: "checkpoint-write",
                              type: "function",
                              function: {
                                name: "write",
                                arguments: JSON.stringify({
                                  path: "memory/checkpoint.md",
                                  content: checkpointText,
                                }),
                              },
                            },
                          ],
                        }
                      : { role: "assistant", content: text },
                    finish_reason: null,
                  },
                ],
              })}\n\n`,
            );
            response.write(
              `data: ${JSON.stringify({
                id: "synthetic-completion",
                object: "chat.completion.chunk",
                created: 1,
                model: "test-model",
                choices: [
                  { index: 0, delta: {}, finish_reason: writeCheckpoint ? "tool_calls" : "stop" },
                ],
                usage: {
                  prompt_tokens: foreground ? 18_000 : 22_000,
                  completion_tokens: 50,
                  total_tokens: foreground ? 18_050 : 22_050,
                },
              })}\n\n`,
            );
            response.end("data: [DONE]\n\n");
          });
        });
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing model fixture address");
        }
        const sessionKey = "agent:main:main";
        const sessionId = "required-maintenance-session";
        const runId = "approved-foreground";
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        const scope = { agentId: "main", sessionKey, sessionId, storePath };
        const cfg: OpenClawConfig = {
          agents: {
            list: [{ id: "main", default: true, workspace: state.workspaceDir }],
            defaults: {
              workspace: state.workspaceDir,
              model: { primary: "test-provider/test-model" },
            },
          },
          session: { store: storePath },
          tools: { profile: "coding" },
          models: {
            providers: {
              "test-provider": {
                api: "openai-completions",
                apiKey: "synthetic-test-key",
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                models: [
                  {
                    id: "test-model",
                    name: "Synthetic model",
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 32_768,
                    contextTokens: 32_768,
                    maxTokens: 8_192,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
        };
        const admissionOwner = prepareSystemAgentRunAdmission(
          cfg,
          `${runId}:ingress`,
          "main",
          "pending-regression",
        );
        let recorder: ReturnType<typeof createUserTurnTranscriptRecorder> | undefined;
        try {
          await state.writeConfig(cfg);
          setRuntimeConfigSnapshot(cfg);
          const admittedRunContext = await admissionOwner.admit("embedded");
          const assertCurrent = resolveAdmittedRunActiveAssertion(admittedRunContext);
          if (!assertCurrent) {
            throw new Error("Missing real admitted run authority");
          }
          let entry: SessionEntry = {
            sessionId,
            updatedAt: Date.now(),
            totalTokens: 19_000,
            totalTokensFresh: true,
            totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
          };
          await replaceSessionEntry(scope, entry);
          const seed = SessionManager.open(scope, state.workspaceDir);
          // One archive continues after a retention no-op; two archives leave
          // a complete prefix for the earlier retention-only pass.
          const priorTurns =
            history === "one archive"
              ? ([[2_000, 19_000]] as const)
              : ([
                  [600, 10_000],
                  [1_400, 19_000],
                ] as const);
          for (const [rows, inputTokens] of priorTurns) {
            seed.appendMessage({
              role: "user",
              content: "Earlier archive context.\n".repeat(rows),
              timestamp: 1,
            });
            seed.appendMessage(
              makeAssistantMessageFixture({
                provider: "test-provider",
                api: "openai-completions",
                model: "test-model",
                content: [{ type: "text", text: "ACK" }],
                stopReason: "stop",
                errorMessage: undefined,
                usage: {
                  input: inputTokens,
                  output: 2,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: inputTokens + 2,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
              }),
            );
          }
          const request = createRestartSafeChatRequest({
            eligible: true,
            message: approved,
            senderIsOwner: true,
            cfg,
          });
          const restartSafeAdmission = resolveRestartSafeChatAdmission({
            agentId: "main",
            cfg,
            clientRunId: runId,
            context: { chatAbortControllers: new Map(), chatQueuedTurns: new Map() },
            entry,
            initialSessionEntry: entry,
            now: Date.now(),
            request,
            sessionId,
            sessionKey,
            storePath,
          });
          expect(restartSafeAdmission).toBeDefined();
          recorder = createUserTurnTranscriptRecorder({
            target: {
              ...scope,
              expectedSessionId: sessionId,
              sessionEntry: undefined,
              config: cfg,
            },
            input: { text: approved, timestamp: Date.now(), idempotencyKey: `${runId}:user` },
            ...buildRestartSafeChatTranscriptState({
              admission: restartSafeAdmission!,
              clientRunId: runId,
              startedAt: Date.now(),
            }),
          });
          // Idle Control UI admission intentionally persists the approved user before ACK.
          expect(await recorder.stageApproved?.({ runId, assertCurrent })).toBe(true);
          await recorder.persistFallback();
          expect(recorder.hasPersisted()).toBe(true);
          const followupRun = createTestFollowupRun({
            agentId: "main",
            agentDir: state.agentDir(),
            sessionId,
            sessionKey,
            sessionFile: sessionKey,
            workspaceDir: state.workspaceDir,
            config: cfg,
            provider: "test-provider",
            model: "test-model",
            messageProvider: "webchat",
            thinkLevel: "off",
            timeoutMs: 30_000,
            senderIsOwner: true,
            suppressNextUserMessagePersistence: true,
            conversationToolPolicy: { deny: ["read"] },
          });
          followupRun.prompt = approved;
          followupRun.userTurnTranscriptRecorder = recorder;
          entry = loadSessionEntry(scope)!;
          const sessionStore = { [sessionKey]: entry };
          registerMemoryCapability("memory-core", {
            flushPlanResolver: () => ({
              softThresholdTokens: 4_000,
              reserveTokensFloor: 8_192,
              forceFlushTranscriptBytes: 2 * 1024 * 1024,
              prompt: "Checkpoint durable notes. Reply NO_REPLY.",
              systemPrompt: "Write durable notes only.",
              relativePath: "memory/checkpoint.md",
            }),
          });
          const foregroundContexts: unknown[][] = [];
          observeForeground = () => {
            foregroundContexts.push(
              SessionManager.open(scope, state.workspaceDir)
                .buildSessionContext()
                .messages.filter(
                  (message) => message.role === "user" || message.role === "assistant",
                ),
            );
          };
          const result = await runReplyAgent({
            commandBody: approved,
            transcriptCommandBody: approved,
            followupRun,
            queueKey: sessionKey,
            resolvedQueue: { mode: "interrupt" },
            shouldSteer: false,
            shouldFollowup: false,
            isActive: false,
            opts: { runId },
            typing: createTypingController({}),
            sessionCtx: { Provider: "webchat", MessageSid: runId, SessionKey: sessionKey },
            sessionEntry: entry,
            sessionStore,
            sessionKey,
            storePath,
            defaultModel: "test-model",
            resolvedVerboseLevel: "off",
            isNewSession: false,
            blockStreamingEnabled: false,
            resolvedBlockStreamingBreak: "message_end",
            shouldInjectGroupIntro: false,
            typingMode: "never",
          });
          expect(advertisedWrite).toBe(true);
          expect(checkpointRequests).toHaveLength(2);
          expect(
            checkpointRequests.flatMap(
              (checkpointRequest) =>
                checkpointRequest.tools?.map((tool) => tool.function?.name) ?? [],
            ),
          ).not.toContain("read");
          expect(
            await readFile(path.join(state.workspaceDir, "memory/checkpoint.md"), "utf8"),
          ).toBe(checkpointText);
          expect(loadSessionEntry(scope)?.memoryFlush?.kind).toBe("succeeded");
          const expectedCompactions = history === "one archive" ? 0 : 1;
          expect(loadSessionEntry(scope)?.compactionCount ?? 0).toBe(expectedCompactions);
          const events = (await loadTranscriptEvents(scope)).map(asOptionalRecord);
          expect(events.filter((event) => event?.type === "compaction")).toHaveLength(
            expectedCompactions,
          );
          const diagnostic = events.map((event) => {
            const message = asOptionalRecord(event?.message);
            return {
              type: event?.type,
              id: event?.id,
              parentId: event?.parentId,
              role: message?.role,
              errorMessage: message?.errorMessage,
            };
          });
          expect
            .soft(result, JSON.stringify(diagnostic))
            .toMatchObject({ text: "FOREGROUND_READY" });
          expect(foregroundRequests).toHaveLength(1);
          const foregroundMessages = foregroundRequests[0]!.messages;
          const userIndex = foregroundMessages.findLastIndex(
            (message) => message.role === "user" && !isModelRuntimeContextCarrier(message),
          );
          const lastUser = foregroundMessages[userIndex];
          expect(providerText(lastUser?.content).endsWith(approved)).toBe(true);
          expect(providerText(lastUser?.content).split(approved)).toHaveLength(2);
          expect(foregroundMessages.filter(isModelRuntimeContextCarrier)).toHaveLength(1);
          expect(foregroundMessages.findIndex(isModelRuntimeContextCarrier)).toBeGreaterThan(
            userIndex,
          );
          expect(foregroundContexts[0]!.at(-1)).toMatchObject({
            role: "user",
            content: approved,
            idempotencyKey: `${runId}:user`,
          });
        } finally {
          await waitForSessionMaintenance(sessionKey);
          recorder?.finishPendingInput?.("interrupted");
          admissionOwner.close();
          clearMemoryPluginState();
          clearRuntimeConfigSnapshot();
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            });
          });
        }
      });
    },
    60_000,
  );
});
