import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { waitForSessionMaintenance } from "../../agents/session-maintenance/coordinator.js";
import { createSessionMaintenanceFollowup } from "../../agents/session-maintenance/run.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildTimestampPrefix,
  timestampOptsFromConfig,
} from "../../gateway/server-methods/agent-timestamp.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { clearMemoryPluginState, registerMemoryCapability } from "../../plugins/memory-state.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";
import { runReplyAgent } from "./agent-runner.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";
import { createTypingController } from "./typing.js";

type ModelRequest = { messages: Array<{ role: string; content: unknown }> };
const text = (content: unknown) =>
  extractTextFromChatContent(content, { joinWith: "\n", normalizeText: (value) => value }) ?? "";

it.each(["completed", "interrupted"] as const)(
  "keeps %s optional memory inference out of the next human turn",
  async (outcome) => {
    await withOpenClawTestState({ label: "private-memory-run" }, async (state) => {
      const entered = createDeferred();
      const interrupted = new AbortController();
      const human = "Reply only FOREGROUND_READY. Preserve ünicode 🦞.\nThis is the human request.";
      const requests: ModelRequest[] = [];
      const server = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          const modelRequest = JSON.parse(body) as ModelRequest;
          requests.push(modelRequest);
          const isHuman = text(
            modelRequest.messages.findLast((m) => m.role === "user")?.content,
          ).endsWith(human);
          response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
          response.flushHeaders();
          if (!isHuman) {
            entered.resolve();
            if (outcome === "interrupted" && requests.length === 1) {
              return;
            }
          }
          response.write(
            `data: ${JSON.stringify({
              id: "private-memory-fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: "test-model",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: isHuman ? "FOREGROUND_READY" : "NO_REPLY" },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              id: "private-memory-fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: "test-model",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 21_000, completion_tokens: 2, total_tokens: 21_002 },
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
        throw new Error("Missing fixture address");
      }
      const scope = {
        agentId: "main",
        sessionId: "private-memory-source",
        sessionKey: "agent:main:main",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const cfg: OpenClawConfig = {
        agents: {
          list: [{ id: "main", default: true, workspace: state.workspaceDir }],
          defaults: {
            workspace: state.workspaceDir,
            model: { primary: "test-provider/test-model" },
          },
        },
        session: { store: scope.storePath },
        tools: { profile: "coding" },
        models: {
          providers: {
            "test-provider": {
              api: "openai-completions",
              apiKey: "synthetic-fixture-key",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              models: [
                {
                  id: "test-model",
                  name: "Fixture",
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
      let flush: ReturnType<typeof runMemoryFlushIfNeeded> | undefined;
      let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
      try {
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        await replaceSessionEntry(scope, {
          sessionId: scope.sessionId,
          updatedAt: Date.now(),
          totalTokens: 21_000,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        });
        const transcript = SessionManager.open(scope, state.workspaceDir);
        transcript.appendMessage({
          role: "user",
          content: "Remember the Cedar project receipt.",
          timestamp: 1,
        });
        transcript.appendMessage(
          makeAssistantMessageFixture({
            provider: "test-provider",
            model: "test-model",
            api: "openai-completions",
            content: [{ type: "text", text: "Cedar receipt saved." }],
            stopReason: "stop",
            errorMessage: undefined,
            usage: {
              input: 21_000,
              output: 2,
              totalTokens: 21_002,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          }),
        );
        const original = await loadTranscriptEvents(scope);
        const entry = loadSessionEntry(scope)!;
        const foreground = createTestFollowupRun({
          ...scope,
          sessionFile: scope.sessionKey,
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          config: cfg,
          provider: "test-provider",
          model: "test-model",
          messageProvider: "webchat",
          thinkLevel: "off",
          timeoutMs: 30_000,
          senderIsOwner: true,
        });
        const maintenance = createSessionMaintenanceFollowup({
          run: foreground.run,
          sessionEntry: entry,
          cfg,
          sessionKey: scope.sessionKey,
          provider: "test-provider",
          model: "test-model",
          auth: {},
        });
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
        admission = await beginSessionWorkAdmission({
          scope: scope.storePath,
          identities: [scope.sessionKey, scope.sessionId],
          signal: interrupted.signal,
          assertAllowed: () => {
            interrupted.signal.throwIfAborted();
            expect(loadSessionEntry(scope)?.sessionId).toBe(scope.sessionId);
          },
        });
        flush = admission.run(() =>
          runMemoryFlushIfNeeded({
            cfg,
            followupRun: maintenance,
            promptForEstimate: "",
            defaultModel: "test-model",
            resolvedVerboseLevel: "off",
            sessionEntry: entry,
            sessionStore: { [scope.sessionKey]: entry },
            sessionKey: scope.sessionKey,
            storePath: scope.storePath,
            isHeartbeat: false,
            abortSignal: interrupted.signal,
          }),
        );
        await Promise.race([
          entered.promise,
          flush.then(() => {
            throw new Error("Memory run ended before reaching inference");
          }),
        ]);
        if (outcome === "interrupted") {
          interrupted.abort(new Error("next human turn"));
        }
        expect((await flush).outcome).toBe(outcome === "interrupted" ? "failed" : "completed");
        admission.release();
        admission = undefined;
        expect(requests).toHaveLength(1);
        expect.soft(await loadTranscriptEvents(scope)).toEqual(original);
        if (outcome === "interrupted") {
          expect.soft(loadSessionEntry(scope)?.memoryFlush).toBeUndefined();
        }
        foreground.prompt = human;
        const current = loadSessionEntry(scope)!;
        const result = await runReplyAgent({
          commandBody: human,
          transcriptCommandBody: human,
          followupRun: foreground,
          queueKey: scope.sessionKey,
          resolvedQueue: { mode: "interrupt" },
          shouldSteer: false,
          shouldFollowup: false,
          isActive: false,
          opts: { runId: "next-human" },
          typing: createTypingController({}),
          sessionCtx: {
            Provider: "webchat",
            MessageSid: "next-human",
            SessionKey: scope.sessionKey,
          },
          sessionEntry: current,
          sessionStore: { [scope.sessionKey]: current },
          sessionKey: scope.sessionKey,
          storePath: scope.storePath,
          defaultModel: "test-model",
          resolvedVerboseLevel: "off",
          isNewSession: false,
          blockStreamingEnabled: false,
          resolvedBlockStreamingBreak: "message_end",
          shouldInjectGroupIntro: false,
          typingMode: "never",
        });
        expect(result).toMatchObject({ text: "FOREGROUND_READY" });
        const humanRequests = requests.filter((modelRequest) =>
          text(
            modelRequest.messages.findLast((message) => message.role === "user")?.content,
          ).endsWith(human),
        );
        expect(humanRequests).toHaveLength(1);
        const nextUser = text(
          humanRequests[0]!.messages.findLast((message) => message.role === "user")?.content,
        );
        const canonicalHuman = SessionManager.open(scope)
          .buildSessionContext()
          .messages.findLast(
            (message) => message.role === "user" && text(message.content) === human,
          );
        if (!canonicalHuman || typeof canonicalHuman.timestamp !== "number") {
          throw new Error("Missing canonical human timestamp");
        }
        const prefix = buildTimestampPrefix(
          new Date(canonicalHuman.timestamp),
          timestampOptsFromConfig(cfg),
        );
        expect(prefix).toBeDefined();
        expect(nextUser).toBe(`${prefix}${human}`);
      } finally {
        interrupted.abort(createAbortError("fixture cleanup"));
        await flush?.catch(() => undefined);
        admission?.release();
        await waitForSessionMaintenance(scope.sessionKey);
        clearMemoryPluginState();
        clearRuntimeConfigSnapshot();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
  },
  60_000,
);
