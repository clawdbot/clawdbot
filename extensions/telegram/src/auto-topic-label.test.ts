// Telegram tests cover auto topic label plugin behavior.
import { describe, expect, it, vi } from "vitest";

const generateConversationLabel = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/reply-dispatch-runtime", () => ({
  generateConversationLabel,
}));

import { resolveAutoTopicLabelConfig } from "./auto-topic-label-config.js";
import { generateTelegramTopicLabel } from "./auto-topic-label.js";

const EXPECTED_DEFAULT_PROMPT =
  "Generate a very short topic label (2-4 words, max 25 chars) for a chat conversation based on the user's first message below. No emoji. Use the same language as the message. Be concise and descriptive. Return ONLY the topic name, nothing else.";

describe("resolveAutoTopicLabelConfig", () => {
  it("returns enabled with default prompt when configs are undefined", () => {
    const result = resolveAutoTopicLabelConfig(undefined, undefined);
    expect(result).toEqual({ enabled: true, prompt: EXPECTED_DEFAULT_PROMPT });
  });

  it("prefers direct config over account config", () => {
    expect(resolveAutoTopicLabelConfig(false, true)).toBeNull();
    expect(
      resolveAutoTopicLabelConfig({ prompt: "DM prompt" }, { prompt: "Account prompt" }),
    ).toEqual({
      enabled: true,
      prompt: "DM prompt",
    });
  });

  it("falls back to default prompt for empty object prompt", () => {
    expect(resolveAutoTopicLabelConfig({ enabled: true, prompt: "  " }, undefined)).toEqual({
      enabled: true,
      prompt: EXPECTED_DEFAULT_PROMPT,
    });
  });
});

describe("generateTelegramTopicLabel", () => {
  it("delegates to the generic conversation label helper with telegram max length", async () => {
    generateConversationLabel.mockResolvedValue("Billing");

    await expect(
      generateTelegramTopicLabel({
        userMessage: "Need help with invoices",
        prompt: "prompt",
        cfg: {},
        agentId: "billing",
      }),
    ).resolves.toBe("Billing");

    expect(generateConversationLabel).toHaveBeenCalledWith({
      userMessage: "Need help with invoices",
      prompt: "prompt",
      cfg: {},
      agentId: "billing",
      maxLength: 128,
    });
  });
});
