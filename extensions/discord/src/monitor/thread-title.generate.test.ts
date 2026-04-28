import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import * as agentRuntimeModule from "openclaw/plugin-sdk/simple-completion-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";

const completeWithPreparedSimpleCompletionModelMock =
  vi.fn<typeof agentRuntimeModule.completeWithPreparedSimpleCompletionModel>();
const prepareSimpleCompletionModelForAgentMock =
  vi.fn<typeof agentRuntimeModule.prepareSimpleCompletionModelForAgent>();
const extractAssistantTextMock = vi.fn<typeof agentRuntimeModule.extractAssistantText>();

let generateThreadTitle: typeof import("./thread-title.js").generateThreadTitle;

beforeAll(async () => {
  ({ generateThreadTitle } = await import("./thread-title.js"));
});

beforeEach(() => {
  vi.restoreAllMocks();
  completeWithPreparedSimpleCompletionModelMock.mockReset();
  prepareSimpleCompletionModelForAgentMock.mockReset();
  extractAssistantTextMock.mockReset();

  prepareSimpleCompletionModelForAgentMock.mockResolvedValue({
    selection: {
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      agentDir: "/tmp/openclaw-agent",
    },
    model: {
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    },
    auth: {
      apiKey: "sk-test",
      source: "env:TEST_API_KEY",
      mode: "api-key",
    },
  } as Awaited<ReturnType<typeof agentRuntimeModule.prepareSimpleCompletionModelForAgent>>);
  completeWithPreparedSimpleCompletionModelMock.mockResolvedValue(
    {} as Awaited<ReturnType<typeof agentRuntimeModule.completeWithPreparedSimpleCompletionModel>>,
  );
  extractAssistantTextMock.mockReturnValue("Generated title");
  vi.spyOn(agentRuntimeModule, "prepareSimpleCompletionModelForAgent").mockImplementation(
    (...args) => prepareSimpleCompletionModelForAgentMock(...args),
  );
  vi.spyOn(agentRuntimeModule, "completeWithPreparedSimpleCompletionModel").mockImplementation(
    (...args) => completeWithPreparedSimpleCompletionModelMock(...args),
  );
  vi.spyOn(agentRuntimeModule, "extractAssistantText").mockImplementation((...args) =>
    extractAssistantTextMock(...args),
  );
});

describe("generateThreadTitle", () => {
  it("calls shared one-shot model prep with aws-sdk allowance", async () => {
    prepareSimpleCompletionModelForAgentMock.mockResolvedValueOnce({
      selection: {
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4-5",
        profileId: "work",
        agentDir: "/tmp/openclaw-agent",
      },
      model: {
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4-5",
      },
      auth: {
        apiKey: "sk-openrouter",
        source: "profile:work",
        mode: "api-key",
      },
    } as Awaited<ReturnType<typeof agentRuntimeModule.prepareSimpleCompletionModelForAgent>>);
    const cfg = {
      agents: {
        defaults: {
          model: "openrouter/anthropic/claude-sonnet-4-5@work",
        },
      },
    } as OpenClawConfig;

    await generateThreadTitle({
      cfg,
      agentId: "main",
      messageText: "Need a generated title.",
    });

    expect(prepareSimpleCompletionModelForAgentMock).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      allowMissingApiKeyModes: ["aws-sdk"],
    });
  });

  it("passes model override refs into shared model prep", async () => {
    const cfg = EMPTY_DISCORD_TEST_CONFIG;
    await generateThreadTitle({
      cfg,
      agentId: "main",
      modelRef: "openai/gpt-4.1-mini@local",
      messageText: "Need a generated title.",
    });

    expect(prepareSimpleCompletionModelForAgentMock).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      modelRef: "openai/gpt-4.1-mini@local",
      allowMissingApiKeyModes: ["aws-sdk"],
    });
  });

  it("returns null when shared model prep cannot resolve selection", async () => {
    prepareSimpleCompletionModelForAgentMock.mockResolvedValueOnce({
      error: "No model configured for agent main.",
    } as Awaited<ReturnType<typeof agentRuntimeModule.prepareSimpleCompletionModelForAgent>>);

    const result = await generateThreadTitle({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      agentId: "main",
      messageText: "Need a thread title.",
    });

    expect(result).toBeNull();
    expect(completeWithPreparedSimpleCompletionModelMock).not.toHaveBeenCalled();
  });

  it("returns null when shared completion prep fails", async () => {
    prepareSimpleCompletionModelForAgentMock.mockResolvedValue({
      error: 'No API key resolved for provider "anthropic" (auth mode: api-key).',
      selection: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        agentDir: "/tmp/openclaw-agent",
      },
    } as Awaited<ReturnType<typeof agentRuntimeModule.prepareSimpleCompletionModelForAgent>>);

    const result = await generateThreadTitle({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      agentId: "main",
      messageText: "Need a thread title.",
    });

    expect(result).toBeNull();
    expect(completeWithPreparedSimpleCompletionModelMock).not.toHaveBeenCalled();
  });

  it("builds contextual prompt and forwards completion options", async () => {
    const result = await generateThreadTitle({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      agentId: "main",
      messageText: "Summarize deployment blockers and owner follow-ups.",
      channelName: "release-status",
      channelDescription: "Deploy updates and incident notes",
    });

    expect(result).toBe("Generated title");
    expect(completeWithPreparedSimpleCompletionModelMock).toHaveBeenCalledTimes(1);
    expect(completeWithPreparedSimpleCompletionModelMock.mock.calls[0]?.[0]?.context).toEqual(
      expect.objectContaining({
        systemPrompt:
          "Generate a concise Discord thread title (3-6 words). Return only the title. Use channel context when provided and avoid redundant channel-name words unless needed for clarity.",
        messages: [
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Channel: release-status"),
          }),
        ],
      }),
    );
    expect(
      completeWithPreparedSimpleCompletionModelMock.mock.calls[0]?.[0]?.context?.messages?.[0]
        ?.content,
    ).toContain("Channel description: Deploy updates and incident notes");
    expect(completeWithPreparedSimpleCompletionModelMock.mock.calls[0]?.[0]?.options).toEqual(
      expect.objectContaining({
        maxTokens: 512,
      }),
    );
    expect(
      completeWithPreparedSimpleCompletionModelMock.mock.calls[0]?.[0]?.options,
    ).not.toHaveProperty("temperature");
  });

  it("returns null when completion throws", async () => {
    completeWithPreparedSimpleCompletionModelMock.mockRejectedValueOnce(
      new Error("network timeout"),
    );

    const result = await generateThreadTitle({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      agentId: "main",
      messageText: "Generate title.",
    });

    expect(result).toBeNull();
  });
});
