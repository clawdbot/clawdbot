import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  prepareModel: vi.fn((params: { model: unknown }) => params.model),
}));

vi.mock("../llm/stream.js", () => ({ completeSimple: mocks.complete }));
vi.mock("@openclaw/ai/transports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/ai/transports")>()),
  prepareModelForSimpleCompletion: mocks.prepareModel,
}));

import { completeWithPreparedSimpleCompletionModel } from "./simple-completion-runtime.js";

const context = { messages: [{ role: "user" as const, content: "pong", timestamp: 1 }] };

beforeEach(() => {
  mocks.complete.mockReset();
  mocks.complete.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  mocks.prepareModel.mockReset();
  mocks.prepareModel.mockImplementation((params: { model: unknown }) => params.model);
});

describe("completeWithPreparedSimpleCompletionModel", () => {
  it("prepares provider-owned stream APIs before running a completion", async () => {
    const model = {
      provider: "ollama",
      id: "llama3.2:latest",
      name: "llama3.2:latest",
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    } satisfies Model<"ollama">;
    const preparedModel = { ...model, api: "openclaw-ollama-simple-test" };
    const cfg = {
      models: { providers: { ollama: { baseUrl: "http://remote-ollama:11434", models: [] } } },
    };
    mocks.prepareModel.mockReturnValueOnce(preparedModel);

    await completeWithPreparedSimpleCompletionModel({
      model,
      auth: { apiKey: "ollama-local", source: "models.json (local marker)", mode: "api-key" },
      cfg,
      context,
    });

    expect(mocks.prepareModel).toHaveBeenCalledWith({
      apiRegistry: expect.anything(),
      model,
      cfg,
    });
    expect(mocks.complete).toHaveBeenCalledWith(preparedModel, context, {
      apiKey: "ollama-local",
    });
  });

  it.each(["max", "ultra"] as const)(
    "normalizes OpenClaw-only %s before using shared model runtime simple completion",
    async (reasoning) => {
      const model = {
        provider: "openai",
        id: "gpt-5.4",
        name: "gpt-5.4",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      } satisfies Model<"openai-responses">;

      await completeWithPreparedSimpleCompletionModel({
        model,
        auth: { apiKey: "sk-test", source: "env:OPENAI_API_KEY", mode: "api-key" },
        context,
        options: { reasoning },
      });

      expect(mocks.complete).toHaveBeenCalledWith(model, context, {
        reasoning: "xhigh",
        apiKey: "sk-test",
      });
    },
  );

  it.each(["max", "ultra"] as const)(
    "uses max for GPT-5.6 simple completions requested with %s",
    async (reasoning) => {
      const model = {
        provider: "openai",
        id: "gpt-5.6-terra",
        name: "gpt-5.6-terra",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 372_000,
        maxTokens: 128_000,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      } satisfies Model<"openai-responses">;

      await completeWithPreparedSimpleCompletionModel({
        model,
        auth: { apiKey: "sk-test", source: "env:OPENAI_API_KEY", mode: "api-key" },
        context,
        options: { reasoning },
      });

      expect(mocks.complete).toHaveBeenCalledWith(model, context, {
        reasoning: "max",
        apiKey: "sk-test",
      });
    },
  );

  it("omits reasoning for local simple completion when thinking is off", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.4",
      name: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    } satisfies Model<"openai-responses">;

    await completeWithPreparedSimpleCompletionModel({
      model,
      auth: { apiKey: "sk-test", source: "env:OPENAI_API_KEY", mode: "api-key" },
      context,
      options: { reasoning: "off" },
    });

    expect(mocks.complete).toHaveBeenCalledWith(model, context, { apiKey: "sk-test" });
  });

  it("preserves explicit off for a prepared Claude Sonnet 5 alias", async () => {
    const model = {
      provider: "anthropic",
      id: "production-sonnet",
      name: "Production Sonnet",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      params: { canonicalModelId: "claude-sonnet-5" },
    } satisfies Model<"anthropic-messages">;
    const preparedModel = {
      ...model,
      api: "openclaw-provider-simple:anthropic:production-sonnet",
    } satisfies Model;
    mocks.prepareModel.mockReturnValueOnce(preparedModel);

    await completeWithPreparedSimpleCompletionModel({
      model,
      auth: { apiKey: "sk-test", source: "env:ANTHROPIC_API_KEY", mode: "api-key" },
      context,
      options: { reasoning: "off" },
    });

    expect(mocks.complete).toHaveBeenCalledWith(preparedModel, context, {
      reasoning: "off",
      apiKey: "sk-test",
    });
  });
});
