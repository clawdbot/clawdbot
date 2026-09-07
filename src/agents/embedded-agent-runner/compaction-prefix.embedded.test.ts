import fs from "node:fs/promises";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { wrapRunWithTestPreparedAdmission } from "../admitted-run-context.test-support.js";
import type { StreamFn } from "../runtime/index.js";
import {
  buildEmbeddedRunnerAssistant,
  createMockUsage,
  immediateEnqueue,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { installEmbeddedRunnerBaseE2eMocks } from "../test-helpers/embedded-agent-runner-e2e-mocks.js";

const stream =
  vi.fn<(...args: Parameters<StreamFn>) => ReturnType<typeof createAssistantMessageEventStream>>();
const model: Model<"anthropic-messages"> = {
  id: "compaction-fixture",
  name: "Compaction fixture",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4_096,
};
type ProductionRun = typeof import("./run.js").runEmbeddedAgent;
let run: (
  params: Omit<Parameters<ProductionRun>[0], "admittedRunContext" | "preparedRunAdmission">,
) => ReturnType<ProductionRun>;
let compact: typeof import("./compact.runtime.js").compactEmbeddedAgentSessionOnDemand;

beforeAll(async () => {
  installEmbeddedRunnerBaseE2eMocks({ hookRunner: "full" });
  vi.doUnmock("../../plugins/provider-hook-runtime.js");
  vi.doMock("../models-config.js", () => ({ ensureOpenClawModelsJson: vi.fn() }));
  vi.doMock("./model.js", async () => {
    const actual = await vi.importActual<typeof import("./model.js")>("./model.js");
    const { AuthStorage, ModelRegistry } = await import("../sessions/index.js");
    return {
      ...actual,
      resolveModelAsync: async () => {
        const authStorage = AuthStorage.inMemory();
        authStorage.setRuntimeApiKey(model.provider, "synthetic-compaction-key");
        const modelRegistry = ModelRegistry.inMemory(authStorage);
        modelRegistry.registerProvider(model.provider, { api: model.api, streamSimple: stream });
        return { model, authStorage, modelRegistry };
      },
    };
  });
  vi.doMock("./stream-resolution.js", async () => ({
    ...(await vi.importActual<typeof import("./stream-resolution.js")>("./stream-resolution.js")),
    resolveEmbeddedAgentStream: () => ({ streamFn: stream, strategy: "session-custom" }),
  }));
  run = wrapRunWithTestPreparedAdmission((await import("./run.js")).runEmbeddedAgent);
  ({ compactEmbeddedAgentSessionOnDemand: compact } = await import("./compact.runtime.js"));
});

const stablePrefix = Array.from(
  { length: 96 },
  (_, index) =>
    `Section ${index}: deterministic prose about prompt stability, session affinity, request shaping, transport continuity, and cache reuse across identical stable prefixes.`,
).join("\n");

describe("embedded foreground prefix reuse", () => {
  it.each([false, true])(
    "reuses the last real foreground request after two turns (tools=%s)",
    async (withTools) => {
      await withOpenClawTestState(
        { label: "compaction-prefix", scenario: "minimal" },
        async (state) => {
          await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), stablePrefix);
          await fs.writeFile(path.join(state.workspaceDir, "fixture.txt"), "Stable tool output.");
          const config: OpenClawConfig = {
            agents: {
              ownership: "explicit",
              entries: { main: { agentDir: state.agentDir() } },
              defaults: {
                model: { primary: `anthropic/${model.id}` },
                compaction: {
                  keepRecentTokens: 1_000,
                  recentTurnsPreserve: 0,
                  postIndexSync: "off",
                },
              },
            },
            tools: { allow: ["read"] },
            models: {
              providers: {
                anthropic: {
                  api: model.api,
                  apiKey: "synthetic-compaction-key",
                  baseUrl: "https://example.test",
                  models: [model],
                },
              },
            },
          };
          const target = {
            agentId: "main",
            sessionId: `prefix-${withTools}`,
            sessionKey: `agent:main:prefix-${withTools}`,
            storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
          };
          let summarizing = false;
          let requestIndex = 0;
          const foregroundRequests: Context[] = [];
          const summaryRequests: Context[] = [];
          stream.mockReset();
          stream.mockImplementation((activeModel, context) => {
            (summarizing ? summaryRequests : foregroundRequests).push({
              ...context,
              messages: structuredClone(context.messages),
            });
            const toolCall = !summarizing && withTools && requestIndex++ % 2 === 0;
            const message = buildEmbeddedRunnerAssistant({
              api: activeModel.api,
              provider: activeModel.provider,
              model: activeModel.id,
              content: toolCall
                ? [
                    {
                      type: "toolCall",
                      id: `read-${requestIndex}`,
                      name: "read",
                      arguments: { path: path.join(state.workspaceDir, "fixture.txt") },
                    },
                  ]
                : [
                    {
                      type: "text",
                      text: summarizing
                        ? "## Goal\nReview the stable instructions.\n## Constraints & Preferences\nPreserve the stable cache prefix.\n## Progress\nBoth requests were reviewed.\n## Key Decisions\nKeep the instructions.\n## Next Steps\nContinue from the latest request.\n## Critical Context\nCACHE-OK"
                        : "CACHE-OK",
                    },
                  ],
              stopReason: toolCall ? "toolUse" : "stop",
              usage: createMockUsage(12_000, 50),
            });
            const result = createAssistantMessageEventStream();
            queueMicrotask(() => {
              result.push({ type: "done", reason: toolCall ? "toolUse" : "stop", message });
              result.end();
            });
            return result;
          });
          const params = {
            sessionId: target.sessionId,
            sessionTarget: target,
            agentId: "main",
            workspaceDir: state.workspaceDir,
            agentDir: state.agentDir(),
            config,
            provider: model.provider,
            model: model.id,
            extraSystemPrompt: "Preserve the stable cache prefix.",
            disableTools: !withTools,
          };
          for (const suffix of ["prime-a", "prime-b"]) {
            const result = await run({
              ...params,
              prompt: `Reply CACHE-OK ${suffix}.\n${stablePrefix}`,
              runId: `${target.sessionId}-${suffix}`,
              timeoutMs: 30_000,
              enqueue: immediateEnqueue,
            });
            expect(
              result.payloads?.map((payload) => payload.text).join(" "),
              JSON.stringify(result.meta.error),
            ).toContain("CACHE-OK");
          }
          expect(foregroundRequests).toHaveLength(withTools ? 4 : 2);
          if (withTools) {
            expect(
              foregroundRequests.at(-1)?.messages.some((message) => message.role === "toolResult"),
            ).toBe(true);
          }
          summarizing = true;
          const result = await compact({
            ...params,
            config: {
              ...config,
              agents: {
                ...config.agents,
                defaults: {
                  ...config.agents?.defaults,
                  models: { [`anthropic/${model.id}`]: { alias: "live-compaction" } },
                  compaction: { ...config.agents?.defaults?.compaction, model: "live-compaction" },
                },
              },
            },
            force: true,
            trigger: "manual",
            runId: `${target.sessionId}-compact`,
            tokenBudget: 512,
          });
          expect(result, JSON.stringify(result)).toMatchObject({ ok: true, compacted: true });
          expect(result.summaryUsage, JSON.stringify(result.summaryUsage)).toEqual([
            expect.objectContaining({ path: "foreground-prefix" }),
          ]);
          expect(summaryRequests.at(-1)?.systemPrompt).toBe(
            foregroundRequests.at(-1)?.systemPrompt,
          );
          expect(summaryRequests.at(-1)?.messages.slice(0, -1)).toEqual(
            foregroundRequests.at(-1)?.messages.slice(0, withTools ? 4 : 2),
          );
          expect(summaryRequests.at(-1)?.tools).toEqual(
            foregroundRequests.at(-1)?.tools?.map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
          );
        },
      );
    },
    120_000,
  );
});
