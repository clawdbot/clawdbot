import { afterEach, describe, expect, it, vi } from "vitest";

const FUTURE_API_DEFAULT_MODEL = "openai/gpt-next-default";
const FUTURE_CODEX_DEFAULT_MODEL = "openai/gpt-next-codex-default";

describe("OpenAI missing auth message", () => {
  afterEach(() => {
    vi.doUnmock("./default-models.js");
    vi.resetModules();
  });

  it("uses the shared OpenAI default model in the ChatGPT/Codex OAuth hint", async () => {
    vi.resetModules();
    vi.doMock("./default-models.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./default-models.js")>();
      return {
        ...actual,
        OPENAI_DEFAULT_MODEL: FUTURE_API_DEFAULT_MODEL,
        OPENAI_CODEX_DEFAULT_MODEL: FUTURE_CODEX_DEFAULT_MODEL,
      };
    });

    const { buildOpenAIProvider } = await import("./openai-provider.js");
    const provider = buildOpenAIProvider();

    const message = provider.buildMissingAuthMessage?.({
      provider: "openai",
      listProfileIds: (providerId: string) => (providerId === "openai" ? ["openai:codex"] : []),
    } as never);

    expect(message).toContain(
      `Use ${FUTURE_CODEX_DEFAULT_MODEL} with the ChatGPT/Codex OAuth profile`,
    );
    expect(message).not.toContain(FUTURE_API_DEFAULT_MODEL);
  });
});
