// Discord tests cover thread title.generate plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  completeWithPreparedSimpleCompletionModel,
  extractAssistantText,
  prepareSimpleCompletionModelForAgent,
} from "openclaw/plugin-sdk/simple-completion-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";

vi.mock("openclaw/plugin-sdk/simple-completion-runtime", { spy: true });

const completeWithPreparedSimpleCompletionModelMock =
  vi.fn<typeof completeWithPreparedSimpleCompletionModel>();
const prepareSimpleCompletionModelForAgentMock =
  vi.fn<typeof prepareSimpleCompletionModelForAgent>();
const extractAssistantTextMock = vi.fn<typeof extractAssistantText>();

let generateThreadTitle: typeof import("./thread-title.js").generateThreadTitle;

function firstCompletionArgs(): Parameters<typeof completeWithPreparedSimpleCompletionModel>[0] {
  const firstCall = completeWithPreparedSimpleCompletionModelMock.mock.calls.at(0);
  if (!firstCall) {
    throw new Error("expected completion call");
  }
  return firstCall[0];
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

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
      maxTokens: 64_000,
    },
    auth: {
      apiKey: "sk-test",
      source: "env:TEST_API_KEY",
      mode: "api-key",
    },
  } as Awaited<ReturnType<typeof prepareSimpleCompletionModelForAgent>>);
  completeWithPreparedSimpleCompletionModelMock.mockResolvedValue(
    {} as Awaited<ReturnType<typeof completeWithPreparedSimpleCompletionModel>>,
  );
  extractAssistantTextMock.mockReturnValue("Generated title");
  vi.mocked(prepareSimpleCompletionModelForAgent).mockImplementation((...args) =>
    prepareSimpleCompletionModelForAgentMock(...args),
  );
  vi.mocked(completeWithPreparedSimpleCompletionModel).mockImplementation((...args) =>
    completeWithPreparedSimpleCompletionModelMock(...args),
  );
  vi.mocked(extractAssistantText).mockImplementation((...args) =>
    extractAssistantTextMock(...args),
  );
});

describe("generateThreadTitle", () => {
  it.each([
    [' "Weekly Release Summary"\nExtra text', "Weekly Release Summary"],
    ['\n\n "Weekly Release Summary"\nExtra text', "Weekly Release Summary"],
    ["```markdown\nWeekly Release Summary\n```", "Weekly Release Summary"],
    ["**Scaling ArcherScore Development Roadmap**", "Scaling ArcherScore Development Roadmap"],
    ['"__Weekly Release Summary__"', "Weekly Release Summary"],
    ["*Plan* for *project*", "*Plan* for *project*"],
    ["**Bold** vs **Strong**", "**Bold** vs **Strong**"],
    ["_intro_ and _outro_", "_intro_ and _outro_"],
    ["**Release *plan***", "Release *plan*"],
    ["***Release plan***", "Release plan"],
    ["__Release _plan___", "Release _plan_"],
  ])("normalizes generated title %j", async (generated, expected) => {
    extractAssistantTextMock.mockReturnValueOnce(generated);

    await expect(
      generateThreadTitle({
        cfg: EMPTY_DISCORD_TEST_CONFIG,
        agentId: "main",
        messageText: "Need a generated title.",
      }),
    ).resolves.toBe(expected);
  });

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
        maxTokens: 64_000,
      },
      auth: {
        apiKey: "sk-openrouter",
        source: "profile:work",
        mode: "api-key",
      },
    } as Awaited<ReturnType<typeof prepareSimpleCompletionModelForAgent>>);
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
      useUtilityModel: true,
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
      useUtilityModel: true,
      allowMissingApiKeyModes: ["aws-sdk"],
    });
  });

  it("returns null when shared model prep cannot resolve selection", async () => {
    prepareSimpleCompletionModelForAgentMock.mockResolvedValueOnce({
      error: "No model configured for agent main.",
    } as Awaited<ReturnType<typeof prepareSimpleCompletionModelForAgent>>);

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
    } as Awaited<ReturnType<typeof prepareSimpleCompletionModelForAgent>>);

    const result = await generateThreadTitle({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      agentId: "main",
      messageText: "Need a thread title.",
    });

    expect(result).toBeNull();
    expect(completeWithPreparedSimpleCompletionModelMock).not.toHaveBeenCalled();
  });

  it("builds contextual prompt and forwards completion options", async () => {
    const now = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    let result: string | null;
    try {
      result = await generateThreadTitle({
        cfg: EMPTY_DISCORD_TEST_CONFIG,
        agentId: "main",
        messageText: "Summarize deployment blockers and owner follow-ups.",
        channelName: "release-status",
        channelDescription: "Deploy updates and incident notes",
      });
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(result).toBe("Generated title");
    expect(completeWithPreparedSimpleCompletionModelMock).toHaveBeenCalledTimes(1);
    const completionArgs = firstCompletionArgs();
    expect(completionArgs.context).toEqual({
      systemPrompt:
        "Generate a concise Discord thread title (3-6 words). Return only the title. Use channel context when provided and avoid redundant channel-name words unless needed for clarity.",
      messages: [
        {
          role: "user",
          content:
            "Channel: release-status\n\nChannel description: Deploy updates and incident notes\n\nMessage:\nSummarize deployment blockers and owner follow-ups.",
          timestamp: now,
        },
      ],
    });
    expect(completionArgs.options).toEqual({
      maxTokens: 4_096,
      signal: completionArgs.options?.signal,
    });
    expect(completionArgs.options?.signal).toBeInstanceOf(AbortSignal);
    expect(completionArgs.options).not.toHaveProperty("temperature");
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });

  it("keeps truncated prompt fields on UTF-16 boundaries", async () => {
    await generateThreadTitle({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      agentId: "main",
      messageText: `${"m".repeat(599)}😀tail`,
      channelName: `${"n".repeat(119)}😀tail`,
      channelDescription: `${"d".repeat(319)}😀tail`,
    });

    const message = firstCompletionArgs().context.messages.at(0);
    const content = typeof message?.content === "string" ? message.content : "";

    expect(hasLoneSurrogate(content)).toBe(false);
    expect(content).toContain(`${"m".repeat(599)}...`);
    expect(content).toContain(`${"n".repeat(119)}...`);
    expect(content).toContain(`${"d".repeat(319)}...`);
  });

  it("clamps completion budget to the selected model output cap", async () => {
    prepareSimpleCompletionModelForAgentMock.mockResolvedValueOnce({
      selection: {
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
        agentDir: "/tmp/openclaw-agent",
      },
      model: {
        provider: "anthropic",
        id: "claude-haiku-4-5",
        maxTokens: 1_024,
      },
      auth: {
        apiKey: "sk-test",
        source: "env:TEST_API_KEY",
        mode: "api-key",
      },
    } as Awaited<ReturnType<typeof prepareSimpleCompletionModelForAgent>>);

    await generateThreadTitle({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      agentId: "main",
      messageText: "Need a generated title.",
    });

    expect(firstCompletionArgs().options?.maxTokens).toBe(1_024);
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
