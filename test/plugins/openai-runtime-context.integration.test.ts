import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submitEmbeddedAttemptPrompt } from "../../src/agents/embedded-agent-runner/run/attempt-prompt-submit.js";
import { buildRuntimeContextCustomMessage } from "../../src/agents/embedded-agent-runner/run/runtime-context-prompt.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../../src/agents/embedded-agent-runner/session-prompt-state.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../src/agents/sessions/agent-session-loop-correctness.test-support.js";
import type { Context, Model } from "../../src/llm/types.js";
import type { ProviderPlugin } from "../../src/plugins/types.js";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";

registerAgentSessionLoopTestLifecycle();
const sessionId = "responses-runtime-context";

afterEach(() => {
  clearEmbeddedSessionPromptStates([sessionId]);
});

describe("runtime-context replay at prompt submission", () => {
  it.each([
    "openai-responses",
    "openai-chatgpt-responses",
    "azure-openai-responses",
    "openai-completions",
  ] as const)("retains the previous tool turn's prefix only for Responses (%s)", async (api) => {
    const { buildOpenAIProvider } = await loadBundledPluginFacade<{
      buildOpenAIProvider: () => ProviderPlugin;
    }>({ pluginId: "openai", artifactBasename: "api.js" });
    const model = { ...testModel, provider: "openai", api };
    const policy = buildOpenAIProvider().buildReplayPolicy?.({
      provider: model.provider,
      modelApi: api,
      modelId: model.id,
    });
    if (!policy) {
      throw new Error("Expected the OpenAI replay policy");
    }
    const requests: Context["messages"][] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push(structuredClone(context.messages));
      return createAssistantResultStream(
        requests.length === 1
          ? createAssistant(
              activeModel,
              [{ type: "toolCall", id: "call_read", name: "read_fixture", arguments: {} }],
              "toolUse",
            )
          : createAssistant(activeModel, [{ type: "text", text: "done" }]),
      );
    });
    const { session } = await createTestSession({
      model,
      customTools: [
        {
          name: "read_fixture",
          label: "Read",
          description: "Read fixture content",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: "text", text: "file contents" }],
            details: {},
          }),
        },
      ],
    });
    const sessionPromptState = getEmbeddedSessionPromptState(sessionId);
    const submit = (text: string) =>
      submitEmbeddedAttemptPrompt({
        attempt: { sessionId },
        activeSession: session,
        appendOnlyRuntimeContext: policy.appendOnlyRuntimeContext,
        contextTokenBudget: 8_000,
        images: [],
        modelPrompt: text,
        onFinalPromptText: vi.fn(),
        onSteeringAcknowledged: vi.fn(),
        runtimeOnly: false,
        sessionPromptState,
        systemPrompt: session.systemPrompt,
        toolResultAggregateMaxChars: 8_000,
        toolResultMaxChars: 4_000,
        toolResultPromptProjectionState: sessionPromptState.toolResults,
        trajectoryRecorder: null,
        transcriptLeafId: null,
        transcriptPrompt: text,
        runtimeContextMessage: buildRuntimeContextCustomMessage(`context for ${text}`),
        promptActiveSession: (prompt, options) => session.prompt(prompt, options),
      });
    await submit("first");
    await submit("second");
    expect(requests).toHaveLength(3);
    const [, firstTurn, nextTurn] = requests;
    if (!firstTurn || !nextTurn) {
      throw new Error("Expected the tool round and next user request");
    }
    expect(firstTurn.slice(-2)).toMatchObject([
      { role: "assistant", content: [{ type: "toolCall", id: "call_read" }] },
      {
        role: "toolResult",
        toolCallId: "call_read",
        isError: false,
        content: [{ type: "text", text: "file contents" }],
      },
    ]);
    if (api === "openai-completions") {
      expect(JSON.stringify(nextTurn)).not.toContain("context for first");
    } else {
      expect(nextTurn.slice(0, firstTurn.length)).toEqual(firstTurn);
      expect(firstTurn.slice(0, 2)).toMatchObject([
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "user", runtimeContextCarrier: true },
      ]);
      expect(nextTurn.slice(firstTurn.length)).toMatchObject([
        { role: "assistant", content: [{ type: "text", text: "done" }] },
        { role: "user", content: [{ type: "text", text: "second" }] },
        { role: "user", runtimeContextCarrier: true },
      ]);
    }
  });
});
