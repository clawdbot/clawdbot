// Mattermost tests cover automatic ack policy and reaction transport.
import { describe, expect, it, vi } from "vitest";
import { createMattermostAckReactionRuntime } from "./ack-reactions.js";
import type { MattermostClient } from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";

function createStubClient(request: MattermostClient["request"]): MattermostClient {
  return {
    baseUrl: "https://mattermost.example.com",
    apiBaseUrl: "https://mattermost.example.com/api/v4",
    token: "bot-token",
    request,
    fetchImpl: fetch,
  };
}

function createRuntime(params: {
  cfg?: OpenClawConfig;
  isDirect?: boolean;
  effectiveWasMentioned?: boolean;
  request?: MattermostClient["request"];
}) {
  const request = params.request ?? (vi.fn(async () => ({})) as MattermostClient["request"]);
  return {
    request,
    runtime: createMattermostAckReactionRuntime({
      cfg: params.cfg ?? {},
      client: createStubClient(request),
      botUserId: "bot-1",
      agentId: "main",
      accountId: "default",
      postId: "post-1",
      gate: {
        isDirect: params.isDirect ?? false,
        isGroup: !(params.isDirect ?? false),
        canDetectMention: true,
        effectiveWasMentioned: params.effectiveWasMentioned ?? true,
        shouldBypassMention: false,
      },
      log: vi.fn(),
    }),
  };
}

describe("createMattermostAckReactionRuntime", () => {
  it.each([
    ["👀", "eyes"],
    [":eyes:", "eyes"],
    ["white_check_mark", "white_check_mark"],
    ["❤️", "heart"],
    ["+1", "+1"],
  ])("normalizes %s to %s", async (input, expected) => {
    const { request, runtime } = createRuntime({
      cfg: { messages: { ackReaction: input, ackReactionScope: "all" } },
    });

    runtime.queueAfterRecord();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    expect(request).toHaveBeenCalledWith("/reactions", {
      method: "POST",
      body: JSON.stringify({ user_id: "bot-1", post_id: "post-1", emoji_name: expected }),
    });
  });

  it.each(["", "🦄", ":eyes", "eyes:", "skin tone"])("rejects invalid name %s", async (input) => {
    const { request, runtime } = createRuntime({
      cfg: { messages: { ackReaction: input, ackReactionScope: "all" } },
    });

    runtime.queueAfterRecord();
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
  });
  it("adds the resolved ack reaction once after recording", async () => {
    const { request, runtime } = createRuntime({});

    runtime.queueAfterRecord();
    runtime.queueAfterRecord();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    expect(request).toHaveBeenCalledWith("/reactions", {
      method: "POST",
      body: JSON.stringify({ user_id: "bot-1", post_id: "post-1", emoji_name: "eyes" }),
    });
  });

  it("does not ack direct messages under the default group-mentions scope", async () => {
    const { request, runtime } = createRuntime({ isDirect: true });

    runtime.queueAfterRecord();
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
  });

  it("does not ack unmentioned group messages under the default scope", async () => {
    const { request, runtime } = createRuntime({ effectiveWasMentioned: false });

    runtime.queueAfterRecord();
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
  });

  it("acks direct messages when scope is all", async () => {
    const { request, runtime } = createRuntime({
      cfg: { messages: { ackReactionScope: "all" } },
      isDirect: true,
    });

    runtime.queueAfterRecord();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  });
});
