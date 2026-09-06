import { reasoningTagTextPolicy } from "@openclaw/ai/internal/openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";
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

import { completeWithPreparedSimpleCompletionModel } from "./simple-completion-execution.js";

const context = { messages: [{ role: "user" as const, content: "pong", timestamp: 1 }] };

function completionRequests() {
  return mocks.complete.mock.calls.map(([model, completionContext, options]) => ({
    model,
    context: completionContext,
    options,
  }));
}

const baseModel = {
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

beforeEach(() => {
  mocks.complete.mockReset();
  mocks.complete.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  mocks.prepareModel.mockReset();
  mocks.prepareModel.mockImplementation((params: { model: unknown }) => params.model);
});

describe("prepared completion import boundary", () => {
  it.each([
    "src/agents/host-prepared-isolated-completion.ts",
    "src/plugin-sdk/simple-completion-runtime.ts",
  ])("%s does not import model/auth preparation", (entry) => {
    expect(findSourceImportBackedges(entry, ["src/agents/simple-completion-runtime.ts"])).toEqual(
      [],
    );
  });
});

describe("completeWithPreparedSimpleCompletionModel", () => {
  it("prepares provider-owned stream APIs before running a completion", async () => {
    const model = {
      ...baseModel,
      provider: "ollama",
      id: "llama3.2:latest",
      name: "llama3.2:latest",
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      reasoning: false,
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
    expect(completionRequests()).toEqual([
      { model: preparedModel, context, options: { apiKey: "ollama-local" } },
    ]);
  });

  it.each([
    ["gpt-5.4", "max", "xhigh"],
    ["gpt-5.4", "ultra", "xhigh"],
    ["gpt-5.6-terra", "max", "max"],
    ["gpt-5.6-terra", "ultra", "max"],
    ["gpt-5.4", "off", undefined],
  ] as const)("maps %s reasoning %s to %s", async (id, reasoning, expected) => {
    const model: Model =
      id === "gpt-5.4"
        ? baseModel
        : {
            ...baseModel,
            id,
            name: id,
            contextWindow: 372_000,
            maxTokens: 128_000,
            thinkingLevelMap: { xhigh: "xhigh", max: "max" },
          };
    await completeWithPreparedSimpleCompletionModel({
      model,
      auth: { apiKey: "sk-test", source: "env:OPENAI_API_KEY", mode: "api-key" },
      context,
      options: { reasoning },
    });
    expect(completionRequests()).toEqual([
      {
        model,
        context,
        options: { ...(expected ? { reasoning: expected } : {}), apiKey: "sk-test" },
      },
    ]);
  });

  it("carries strict visibility internally without adding a wire option", async () => {
    await completeWithPreparedSimpleCompletionModel({
      model: baseModel,
      auth: { apiKey: "test", source: "models.json", mode: "api-key" },
      context,
      options: { strictReasoningTags: true },
    });
    const options = mocks.complete.mock.calls[0]?.[2] as object | undefined;
    expect(reasoningTagTextPolicy.isStrict(options)).toBe(true);
    expect(Object.keys(options ?? {})).toEqual(["apiKey"]);
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

    expect(completionRequests()).toEqual([
      { model: preparedModel, context, options: { reasoning: "off", apiKey: "sk-test" } },
    ]);
  });
});
