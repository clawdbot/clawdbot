import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processCompletionsStream } from "../../packages/ai/src/transports/openai-completions-stream.js";
import type { AssistantMessage, Model } from "../llm/types.js";
import { summarizeText } from "./tts-core.js";
import {
  clearRuntimeConfigSnapshot,
  createMockSpeechProvider,
  createTtsConfig,
  installSpeechProviders,
  maybeApplyTtsToPayloadCore,
  prepareSynthesisMock,
  resolveTtsConfig,
  setTtsMachinePrefsPathResolver,
  synthesizeMock,
  textToSpeechCore,
  type OpenClawConfig,
} from "./tts-runtime.test-support.js";

type Completion =
  typeof import("../agents/simple-completion-runtime.js").completeWithPreparedSimpleCompletionModel;
const completion = vi.hoisted(() => ({
  complete: vi.fn<Completion>(),
  prepare: vi.fn(),
}));

vi.mock("../agents/simple-completion-runtime.js", () => ({
  completeWithPreparedSimpleCompletionModel: completion.complete,
  prepareSimpleCompletionModel: completion.prepare,
}));

const model = {
  id: "test-summary",
  name: "Test summary",
  provider: "test-provider",
  api: "openai-completions",
  baseUrl: "https://summary.example.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024,
} satisfies Model<"openai-completions">;

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

const originalText = "The original reply remains visible. ".repeat(60);
const persistAudio = vi.fn(async () => "/tmp/synthetic-summary.ogg");
let cfg: OpenClawConfig;

beforeEach(() => {
  cfg = {
    ...createTtsConfig(`openclaw-tts-summary-${randomUUID()}`),
    agents: { defaults: { model: { primary: "test-provider/test-summary" } } },
    tts: { auto: "always", provider: "mock", summaryModel: "test-provider/test-summary" },
  };
  installSpeechProviders([createMockSpeechProvider()]);
  completion.complete.mockReset();
  completion.prepare.mockReturnValue({
    model,
    auth: { apiKey: "synthetic-test-key", source: "test", mode: "api-key" },
  });
  synthesizeMock.mockClear();
  prepareSynthesisMock.mockClear();
  persistAudio.mockClear();
});

afterEach(() => {
  setTtsMachinePrefsPathResolver();
  clearRuntimeConfigSnapshot();
});

function summarize() {
  return summarizeText({
    text: originalText,
    targetLength: 120,
    cfg,
    config: resolveTtsConfig(cfg),
    timeoutMs: 1000,
  });
}

function applySummaryToSpeech() {
  return maybeApplyTtsToPayloadCore(
    { payload: { text: originalText }, cfg, channel: "telegram", kind: "final" },
    persistAudio,
  );
}

describe("TTS summary visible text", () => {
  it.each([
    {
      name: "reasoning split across text blocks",
      content: [
        { type: "thinking", thinking: "Separate private reasoning" },
        { type: "text", text: "<think>Hidden reasoning" },
        { type: "text", text: "continues</think>Spoken summary." },
      ],
      expected: "Spoken summary.",
    },
    {
      name: "tool scaffolding and model control tokens",
      content: [
        {
          type: "text",
          text: '<tool_call>{"name":"private_tool"}</tool_call><|im_end|>Spoken summary.',
        },
      ],
      expected: "Spoken summary.",
    },
    {
      name: "ordinary prose and quoted tag examples",
      content: [
        { type: "text", text: "The narrator says: use `<think>example</think>` literally." },
      ],
      expected: "The narrator says: use `<think>example</think>` literally.",
    },
  ] satisfies Array<{ name: string; content: AssistantMessage["content"]; expected: string }>)(
    "returns only visible summary text: $name",
    async ({ content, expected }) => {
      completion.complete.mockResolvedValue(assistant(content));
      const result = await summarize();
      expect(result.summary).toBe(expected);
      expect(result.outputLength).toBe(expected.length);
      expect(result.inputLength).toBe(originalText.length);
    },
  );

  it("rejects summary text that sanitizes to empty", async () => {
    completion.complete.mockResolvedValue(
      assistant([{ type: "text", text: "<think>Private only</think>" }]),
    );
    await expect(summarize()).rejects.toThrow("No summary returned");
  });

  it("does not recover unterminated reasoning as summary text at the transport boundary", async () => {
    completion.complete.mockImplementation(async ({ options }) => {
      const output = assistant([]);
      async function* chunks() {
        yield {
          id: "summary-chunk",
          object: "chat.completion.chunk" as const,
          created: 0,
          model: model.id,
          choices: [
            {
              index: 0,
              delta: { content: "<think>Private reasoning without a close tag" },
              finish_reason: "stop" as const,
              logprobs: null,
            },
          ],
        };
      }
      await processCompletionsStream(
        chunks(),
        output,
        model,
        { push() {} },
        {
          strictReasoningTags: options?.strictReasoningTags,
        },
      );
      return output;
    });
    await expect(summarize()).rejects.toThrow("No summary returned");
  });

  it("hands the sanitized summary to synthesis while preserving the visible original reply", async () => {
    completion.complete.mockResolvedValue(
      assistant([{ type: "text", text: "<think>Private reasoning</think>Spoken summary." }]),
    );
    const result = await applySummaryToSpeech();
    expect(synthesizeMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "Spoken summary." }),
    );
    expect(result).toMatchObject({
      text: originalText,
      spokenText: "Spoken summary.",
      mediaUrl: "/tmp/synthetic-summary.ogg",
    });
  });

  it("keeps the existing original-text fallback when the summary has no visible content", async () => {
    completion.complete.mockResolvedValue(
      assistant([{ type: "text", text: "<think>Private only</think>" }]),
    );
    const result = await applySummaryToSpeech();
    expect(synthesizeMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: `${originalText.slice(0, 1497)}...` }),
    );
    expect(result.text).toBe(originalText);
  });

  it("does not sanitize explicitly requested TTS text as model-generated summary output", async () => {
    const text = "Say the literal marker <think>example</think> out loud.";
    const result = await textToSpeechCore({ text, cfg, channel: "telegram" }, persistAudio);
    expect(result.success).toBe(true);
    expect(synthesizeMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text }));
    expect(completion.complete).not.toHaveBeenCalled();
  });
});
