import { describe, expect, it, vi } from "vitest";

const generateConversationLabel = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  generateConversationLabel,
}));

import {
  AUTO_TOPIC_LABEL_DEFAULT_PROMPT,
  generateTelegramTopicLabel,
  resolveAutoTopicLabelConfig,
} from "./auto-topic-label.js";

describe("resolveAutoTopicLabelConfig", () => {
  it("returns enabled with default prompt when configs are undefined", () => {
    const result = resolveAutoTopicLabelConfig(undefined, undefined);
    expect(result).toEqual({ enabled: true, prompt: AUTO_TOPIC_LABEL_DEFAULT_PROMPT });
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
      prompt: AUTO_TOPIC_LABEL_DEFAULT_PROMPT,
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
