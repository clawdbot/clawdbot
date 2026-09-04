// Slack tests cover suggested-prompt capability detection across view generations.
import type { App } from "@slack/bolt";
import {
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
} from "@slack/web-api";
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

    await updateSlackSuggestedPrompts({
      botToken: "",
      client: createSlackClient(setSuggestedPrompts),
      channelId: "D123",
      title: "Try asking",
      prompts: [{ title: "Draft a reply", message: "Help me draft a reply." }],
    });

    expect(setSuggestedPrompts).toHaveBeenCalledWith({
      token: "",
      channel_id: "D123",
      title: "Try asking",
      prompts: [{ title: "Draft a reply", message: "Help me draft a reply." }],
    });
  });

  it.each([
    ["successful update", undefined, "accepted"],
    ["non-Agent app", new WebAPIPlatformError({ ok: false, error: "not_agent_app" }), "rejected"],
    ["missing scope", new WebAPIPlatformError({ ok: false, error: "missing_scope" }), "rejected"],
    [
      "internal error",
      new WebAPIPlatformError({ ok: false, error: "internal_error" }),
      "internal_error",
    ],
    [
      "other platform error",
      new WebAPIPlatformError({ ok: false, error: "invalid_auth" }),
      "failed",
    ],
    ["request failure", new WebAPIRequestError(new Error("connection reset")), "failed"],
    [
      "HTTP failure",
      new WebAPIHTTPError(500, "Internal Server Error", {}, "internal_error"),
      "failed",
    ],
    ["rate limit", new WebAPIRateLimitedError(30), "failed"],
    ["unknown error", new Error("internal_error"), "failed"],
  ] as const)("classifies %s", async (_name, error, outcome) => {
    const setSuggestedPrompts = error
      ? vi.fn().mockRejectedValue(error)
      : vi.fn().mockResolvedValue({ ok: true });

    const updated = await updateSlackSuggestedPrompts({
      botToken: "",
      client: createSlackClient(setSuggestedPrompts),
      channelId: "D123",
      prompts: [{ title: "Draft a reply", message: "Help me draft a reply." }],
    });

    expect(updated).toBe(outcome);
  });
});
