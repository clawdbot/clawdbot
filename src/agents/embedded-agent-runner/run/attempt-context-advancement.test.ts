import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Message,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../../../context-engine/types.js";
import { Agent, type AgentMessage } from "../../runtime/index.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { installEmbeddedAttemptContextGuards } from "./attempt-setup.js";

const model: Model = {
  id: "synthetic-model",
  name: "Synthetic",
  api: "openai-responses",
  provider: "synthetic",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("context advancement through embedded attempt guards", () => {
  it.each(
    (["afterTurn", "ingestBatch", "ingest"] as const).flatMap((ingestion) =>
      (["stop", "error", "aborted"] as const).flatMap((terminal) =>
        (["stored-prefix", "live-input"] as const).map((assembly) => ({
          ingestion,
          terminal,
          assembly,
        })),
      ),
    ),
  )(
    "preserves live context with $assembly assembly and defers $ingestion after $terminal",
    async ({ ingestion, terminal, assembly }) => {
      const remembered: AgentMessage[] = [];
      const history: AgentMessage[] = [
        { role: "user", content: "Earlier accepted request.", timestamp: 0 },
        {
          role: "assistant",
          content: [{ type: "text", text: "Earlier accepted answer." }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          timestamp: 0,
          stopReason: "stop",
        },
      ];
      const storedPrefix: AgentMessage[] = [
        { role: "user", content: "Summary of accepted history.", timestamp: 0 },
      ];
      const assemble = vi.fn<ContextEngine["assemble"]>(async ({ messages }) => ({
        messages: assembly === "stored-prefix" ? storedPrefix : messages,
        estimatedTokens: 0,
      }));
      const commitTurn = vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => ({
        status: "committed",
      }));
      const engine: ContextEngine = {
        info: {
          id: "synthetic-engine",
          name: "Synthetic",
          ownsCompaction: true,
          transcriptSemantics: {
            currentTurnFence: "before-current-turn-entry-v1",
            turnAdvancementIdempotency: "atomic-idempotent-v1",
          },
        },
        ingest: async ({ message }) => {
          remembered.push(message);
          return { ingested: true };
        },
        ...(ingestion === "afterTurn"
          ? {
              afterTurn: async ({
                messages,
                prePromptMessageCount,
              }: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) => {
                remembered.push(...messages.slice(prePromptMessageCount));
              },
            }
          : {}),
        ...(ingestion === "ingestBatch"
          ? {
              ingestBatch: async ({
                messages,
              }: Parameters<NonNullable<ContextEngine["ingestBatch"]>>[0]) => {
                remembered.push(...messages);
                return { ingestedCount: messages.length };
              },
            }
          : {}),
        assemble,
        compact: async () => ({ ok: true, compacted: false, reason: "fits" }),
        commitTurn,
      };
      let providerCalls = 0;
      let secondModelMessages: Message[] | undefined;
      const execute = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "fixture observation" }],
        details: {},
      }));
      const agent = new Agent({
        initialState: {
          model,
          messages: history,
          tools: [
            {
              name: "read_fixture",
              label: "Read fixture",
              description: "Read fixture",
              parameters: { type: "object", properties: {} },
              execute,
            },
          ],
        },
        streamFn: (_model, context) => {
          providerCalls++;
          if (providerCalls === 2) {
            secondModelMessages = structuredClone(context.messages);
          }
          const stopReason = providerCalls === 1 ? "toolUse" : terminal;
          if (stopReason === "aborted") {
            agent.abort();
          }
          const message: AssistantMessage = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage,
            timestamp: 1,
            content:
              stopReason === "toolUse"
                ? [{ type: "toolCall", id: "read-1", name: "read_fixture", arguments: {} }]
                : [{ type: "text", text: "done" }],
            stopReason,
          };
          const stream = createAssistantMessageEventStream();
          stream.push(
            stopReason === "error" || stopReason === "aborted"
              ? { type: "error", reason: stopReason, error: message }
              : { type: "done", reason: stopReason, message },
          );
          stream.end();
          return stream;
        },
      });
      const guards = installEmbeddedAttemptContextGuards({
        activeContextEngine: engine,
        activeSession: { agent },
        agentDir: process.cwd(),
        attempt: {
          config: {},
          prompt: "Read the fixture.",
          contextTokenBudget: 8192,
          model,
          modelId: model.id,
          provider: model.provider,
          sessionId: "synthetic-session",
          sessionKey: "agent:synthetic:main",
          sessionFile: "unused",
          onContextEngineTurnCandidate: vi.fn(),
        },
        computerContextEpoch: { value: 0 },
        dropThinkingBlocksForEstimate: false,
        effectiveCwd: process.cwd(),
        effectiveFsWorkspaceOnly: true,
        effectiveWorkspace: process.cwd(),
        getPrePromptMessageCount: () => history.length,
        getPromptCache: () => ({ retention: "none" }),
        getPromptCacheRetention: () => "none",
        getCompactionReplayEnabled: () => false,
        getServerToolClearingEnabled: () => false,
        toolResultPromptProjectionState: createToolResultPromptProjectionState(),
        getSystemPrompt: () => "",
        isOpenAIResponsesApi: false,
        repairToolUseResultPairing: false,
        sessionAgentId: "synthetic",
        sessionManager: {},
        settingsManager: { getBlockImages: () => false, getCompactionReserveTokens: () => 64 },
      } as never);
      try {
        await agent.prompt("Read the fixture.");
        expect(providerCalls).toBe(2);
        expect(execute).toHaveBeenCalledOnce();
        expect(
          agent.state.messages.toReversed().find((message) => message.role === "assistant")
            ?.stopReason,
        ).toBe(terminal);
        expect(assemble).toHaveBeenCalledTimes(2);
        expect(secondModelMessages).toMatchObject([
          ...(assembly === "stored-prefix" ? storedPrefix : history),
          { role: "user", content: [{ type: "text", text: "Read the fixture." }] },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "read-1", name: "read_fixture", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "read-1",
            content: [{ type: "text", text: "fixture observation" }],
          },
        ]);
        expect(assemble.mock.calls[1]?.[0]).toMatchObject({
          prompt: "Read the fixture.",
          availableTools: new Set(["read_fixture"]),
        });
        expect(assemble.mock.calls[1]?.[0].tokenBudget).toBeLessThan(8192);
        expect(commitTurn).not.toHaveBeenCalled();
        expect(remembered).toEqual([]);
        expect(guards.getAfterTurnCheckpoint()).toBeNull();
      } finally {
        agent.abort();
        await agent.waitForIdle();
        guards.remove();
      }
    },
  );
});
