import { afterEach, describe, expect, it, vi } from "vitest";
import type { ensureApiKeyFromEnvOrPrompt } from "../plugins/provider-auth-input.js";
import { promptCustomApiConfig } from "./onboard-custom.js";

vi.mock("../plugins/provider-auth-input.js", () => ({
  ensureApiKeyFromEnvOrPrompt: vi.fn(
    async (params: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]) => {
      await params.prompter.select({ message: "Secret input mode", options: [] });
      const input = await params.prompter.text({
        message: params.promptMessage,
        validate: params.validate,
      });
      const apiKey = params.normalize(input ?? "");
      await params.setCredential(apiKey);
      return apiKey;
    },
  ),
}));

function createTestPrompter(params: { text: string[]; select?: string[]; confirm?: boolean[] }): {
  text: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  note: ReturnType<typeof vi.fn>;
  progress: ReturnType<typeof vi.fn>;
} {
  const text = vi.fn();
  for (const answer of params.text) {
    text.mockResolvedValueOnce(answer);
  }
  const select = vi.fn();
  for (const answer of params.select ?? []) {
    select.mockResolvedValueOnce(answer);
  }
  const confirm = vi.fn(async () => false);
  for (const answer of params.confirm ?? []) {
    confirm.mockResolvedValueOnce(answer);
  }
  return {
    text,
    progress: vi.fn(() => ({
      update: vi.fn(),
      stop: vi.fn(),
    })),
    select,
    confirm,
    note: vi.fn(),
  };
}

function stubFetchSequence(
  responses: Array<{ ok: boolean; status?: number }>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce({
      ok: response.ok,
      status: response.status,
      json: async () => ({}),
    });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function runPromptCustomApi(
  prompter: ReturnType<typeof createTestPrompter>,
  config: object = {},
) {
  return promptCustomApiConfig({
    prompter: prompter as unknown as Parameters<typeof promptCustomApiConfig>[0]["prompter"],
    runtime: { log: vi.fn() } as unknown as Parameters<typeof promptCustomApiConfig>[0]["runtime"],
    config,
  });
}

function expectOpenAiCompatResult(params: {
  prompter: ReturnType<typeof createTestPrompter>;
  textCalls: number;
  selectCalls: number;
  result: Awaited<ReturnType<typeof runPromptCustomApi>>;
}) {
  expect(params.prompter.text).toHaveBeenCalledTimes(params.textCalls);
  expect(params.prompter.select).toHaveBeenCalledTimes(params.selectCalls);
  expect(params.result.config.models?.providers?.custom?.api).toBe("openai-completions");
}

describe("promptCustomApiConfig", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("handles openai flow and saves alias", async () => {
    const prompter = createTestPrompter({
      text: ["http://localhost:11434/v1", "", "llama3", "custom", "local"],
      select: ["plaintext", "openai"],
    });
    stubFetchSequence([{ ok: true }]);
    const result = await runPromptCustomApi(prompter);

    expectOpenAiCompatResult({ prompter, textCalls: 5, selectCalls: 2, result });
    expect(result.config.agents?.defaults?.models?.["custom/llama3"]?.alias).toBe("local");
    expect(result.config.models?.providers?.custom?.models?.[0]?.input).toEqual(["text"]);
    expect(prompter.confirm).not.toHaveBeenCalled();
  });

  it("skips the image-input prompt for known custom vision models", async () => {
    const prompter = createTestPrompter({
      text: ["https://proxy.example.com/v1", "test-key", "gpt-4o", "custom", ""],
      select: ["plaintext", "openai"],
    });
    stubFetchSequence([{ ok: true }]);

    const result = await runPromptCustomApi(prompter);

    expect(result.config.models?.providers?.custom?.models?.[0]?.input).toEqual(["text", "image"]);
    expect(prompter.confirm).not.toHaveBeenCalled();
  });

  it("prompts for custom model image support when the model is unknown", async () => {
    const prompter = createTestPrompter({
      text: ["https://proxy.example.com/v1", "test-key", "private-model", "custom", ""],
      select: ["plaintext", "openai"],
      confirm: [true],
    });
    stubFetchSequence([{ ok: true }]);

    const result = await runPromptCustomApi(prompter);

    expect(result.config.models?.providers?.custom?.models?.[0]?.input).toEqual(["text", "image"]);
    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "Does this model support image input?",
      initialValue: false,
    });
  });

  it("does not seed custom setup with a provider-specific base URL", async () => {
    const prompter = createTestPrompter({
      text: ["http://localhost:11434", "", "llama3", "custom", ""],
      select: ["plaintext", "openai"],
    });
    stubFetchSequence([{ ok: true }]);

    await runPromptCustomApi(prompter);

    const apiBaseUrlCall = prompter.text.mock.calls.find(
      ([options]) => options.message === "API Base URL",
    );
    expect(apiBaseUrlCall?.[0].initialValue).toBeUndefined();
  });

  it("retries when verification fails", async () => {
    const prompter = createTestPrompter({
      text: ["http://localhost:11434/v1", "", "bad-model", "good-model", "custom", ""],
      select: ["plaintext", "openai", "model"],
    });
    stubFetchSequence([{ ok: false, status: 400 }, { ok: true }]);
    await runPromptCustomApi(prompter);

    expect(prompter.text).toHaveBeenCalledTimes(6);
    expect(prompter.select).toHaveBeenCalledTimes(3);
  });

  it("detects openai compatibility when unknown", async () => {
    const prompter = createTestPrompter({
      text: ["https://example.com/v1", "test-key", "detected-model", "custom", "alias"],
      select: ["plaintext", "unknown"],
    });
    stubFetchSequence([{ ok: true }]);
    const result = await runPromptCustomApi(prompter);

    expectOpenAiCompatResult({ prompter, textCalls: 5, selectCalls: 2, result });
  });

  it("re-prompts base url when unknown detection fails", async () => {
    const prompter = createTestPrompter({
      text: [
        "https://bad.example.com/v1",
        "bad-key",
        "bad-model",
        "https://ok.example.com/v1",
        "ok-key",
        "custom",
        "",
      ],
      select: ["plaintext", "unknown", "baseUrl", "plaintext"],
    });
    stubFetchSequence([{ ok: false, status: 404 }, { ok: false, status: 404 }, { ok: true }]);
    await runPromptCustomApi(prompter);

    expect(prompter.note).toHaveBeenCalledWith(
      "This endpoint did not respond to OpenAI or Anthropic style requests.",
      "Endpoint detection",
    );
  });

  it("aborts verification after timeout", async () => {
    vi.useFakeTimers();
    const prompter = createTestPrompter({
      text: ["http://localhost:11434/v1", "", "slow-model", "fast-model", "custom", ""],
      select: ["plaintext", "openai", "model"],
    });

    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
        });
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const promise = runPromptCustomApi(prompter);

    await vi.advanceTimersByTimeAsync(30_000);
    await promise;

    expect(prompter.text).toHaveBeenCalledTimes(6);
  });
});
