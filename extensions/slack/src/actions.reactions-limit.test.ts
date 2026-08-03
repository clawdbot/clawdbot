import { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSlackAction, slackActionRuntime } from "./action-runtime.js";
import {
  listSlackReactions,
  removeOwnSlackReactions,
  type SlackMessageSummary,
} from "./actions.js";
import { createSlackActions } from "./channel-actions.js";

type SlackReaction = NonNullable<SlackMessageSummary["reactions"]>[number];

const slackConfig = {
  channels: { slack: { botToken: "xoxb-local-proof", groupPolicy: "open" } },
} as OpenClawConfig;

function createSlackReactionClient(reactions: SlackReaction[]) {
  const calls: Array<{ method: string; body: URLSearchParams }> = [];
  const client = new WebClient("xoxb-local-proof", {
    retryConfig: { retries: 0 },
    fetch: async (input, init) => {
      const method = new URL(String(input)).pathname.split("/").at(-1) ?? "";
      const requestBody = init?.body;
      if (typeof requestBody !== "string") {
        throw new Error("Slack reaction requests must use URL-encoded request bodies.");
      }
      const body = new URLSearchParams(requestBody);
      calls.push({ method, body });
      const result =
        method === "reactions.get"
          ? { ok: true, channel: "C1", message: { reactions } }
          : method === "auth.test"
            ? { ok: true, user_id: "UBOT" }
            : method === "reactions.remove"
              ? { ok: true }
              : null;
      if (!result) {
        throw new Error(`Unexpected Slack API method: ${method}`);
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, calls };
}

async function readSlackReactionsThroughPublicAction(params: {
  client: WebClient;
  limit?: number;
}) {
  vi.spyOn(slackActionRuntime, "resolveSlackConversationInfo").mockResolvedValue({
    type: "channel",
  });
  vi.spyOn(slackActionRuntime, "listSlackReactions").mockImplementation(
    (channelId, messageId, options) =>
      listSlackReactions(channelId, messageId, { ...options, client: params.client }),
  );
  const result = await createSlackActions("slack").handleAction?.({
    action: "reactions",
    cfg: slackConfig,
    conversationReadOrigin: "direct-operator",
    params: {
      channelId: "C1",
      messageId: "123.456",
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    },
  } as never);
  const content = result?.content[0];
  if (!content || content.type !== "text") {
    throw new Error("Slack reactions did not return a text tool result.");
  }
  return JSON.parse(content.text) as { ok: boolean; reactions: SlackReaction[] };
}

describe("Slack reaction user limits", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("limits users per emoji through the public action without changing reaction facts", async () => {
    const { client, calls } = createSlackReactionClient([
      { name: "eyes", count: 3, users: ["U1", "U2", "UBOT"] },
      { name: "wave", count: 2, users: ["U3", "U4"] },
      { name: "heart", count: 5 },
      { name: "party", count: 0, users: [] },
    ]);

    const result = await readSlackReactionsThroughPublicAction({ client, limit: 1 });

    expect(result).toEqual({
      ok: true,
      reactions: [
        { name: "eyes", count: 3, users: ["U1"] },
        { name: "wave", count: 2, users: ["U3"] },
        { name: "heart", count: 5 },
        { name: "party", count: 0, users: [] },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("reactions.get");
    expect(calls[0]?.body.get("full")).toBe("true");
    expect(calls[0]?.body.has("limit")).toBe(false);
  });

  it.each([
    { name: "omitted", limit: undefined },
    { name: "larger than the hard cap", limit: 500 },
    { name: "the largest safe integer", limit: Number.MAX_SAFE_INTEGER },
  ])("caps $name user limits at 100 users per emoji", async ({ limit }) => {
    const users = Array.from({ length: 101 }, (_, index) => `U${index + 1}`);
    const { client } = createSlackReactionClient([{ name: "eyes", count: 101, users }]);

    const result = await readSlackReactionsThroughPublicAction({ client, limit });

    expect(result.reactions).toEqual([{ name: "eyes", count: 101, users: users.slice(0, 100) }]);
    expect(users).toHaveLength(101);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid direct action limit %s before Slack API work", async (limit) => {
    const reactionLookup = vi.spyOn(slackActionRuntime, "listSlackReactions");

    await expect(
      handleSlackAction(
        { action: "reactions", channelId: "C1", messageId: "123.456", limit },
        slackConfig,
      ),
    ).rejects.toThrow("limit must be a positive integer.");
    expect(reactionLookup).not.toHaveBeenCalled();
  });

  it("preserves all reaction users for existing live approval helper callers", async () => {
    const users = [...Array.from({ length: 100 }, (_, index) => `U${index + 1}`), "U_APPROVER"];
    const { client } = createSlackReactionClient([
      { name: "white_check_mark", count: users.length, users },
    ]);

    await expect(listSlackReactions("C1", "123.456", { client })).resolves.toEqual([
      { name: "white_check_mark", count: users.length, users },
    ]);
  });

  it("removes the bot's own reaction when its user is beyond the public cap", async () => {
    const users = [...Array.from({ length: 100 }, (_, index) => `U${index + 1}`), "UBOT"];
    const { client, calls } = createSlackReactionClient([
      { name: "eyes", count: users.length, users },
    ]);

    await expect(removeOwnSlackReactions("C1", "123.456", { client })).resolves.toEqual(["eyes"]);

    expect(calls.map(({ method }) => method)).toEqual([
      "auth.test",
      "reactions.get",
      "reactions.remove",
    ]);
    expect(calls[2]?.body.get("name")).toBe("eyes");
  });
});
