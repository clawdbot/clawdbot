// Slack tests cover suggested-prompt capability detection across view generations.
import type { App } from "@slack/bolt";
import { describe, expect, it, vi } from "vitest";
import { updateSlackSuggestedPrompts } from "./suggested-prompts.js";

function createSlackClient(setSuggestedPrompts: ReturnType<typeof vi.fn>): App["client"] {
  return {
    assistant: {
      threads: {
        setSuggestedPrompts,
      },
    },
  } as unknown as App["client"];
}

describe("updateSlackSuggestedPrompts", () => {
  it("omits thread_ts for the Agent View capability probe", async () => {
    const setSuggestedPrompts = vi.fn().mockResolvedValue({ ok: true });

    const updated = await updateSlackSuggestedPrompts({
      botToken: "",
      client: createSlackClient(setSuggestedPrompts),
      channelId: "D123",
      title: "Try asking",
      prompts: [{ title: "Draft a reply", message: "Help me draft a reply." }],
    });

    expect(updated).toBe(true);
    expect(setSuggestedPrompts).toHaveBeenCalledWith({
      token: "",
      channel_id: "D123",
      title: "Try asking",
      prompts: [{ title: "Draft a reply", message: "Help me draft a reply." }],
    });
  });

  it("rejects the capability probe when Slack requires an Assistant View thread", async () => {
    const setSuggestedPrompts = vi.fn().mockRejectedValue({
      data: { ok: false, error: "invalid_arguments" },
    });

    const updated = await updateSlackSuggestedPrompts({
      botToken: "",
      client: createSlackClient(setSuggestedPrompts),
      channelId: "D123",
      prompts: [{ title: "Draft a reply", message: "Help me draft a reply." }],
    });

    expect(updated).toBe(false);
  });
});
