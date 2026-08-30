import { WebClient, type WebClientOptions } from "@slack/web-api";
import type {
  ChannelMessageActionContext,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackActions } from "./channel-actions.js";
import * as slackClient from "./client.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

type SlackRequest = {
  method: string;
  args: Record<string, string>;
  authorization: string | null;
};

function createConversationFixture(
  conversationId = "C01234567",
  openResponse?: Record<string, unknown>,
) {
  const requests: SlackRequest[] = [];
  const cfg: OpenClawConfig = {
    channels: {
      slack: {
        botToken: "xoxb-test",
        userToken: "xoxp-readonly",
        userTokenReadOnly: true,
      },
    },
  };
  const fetch: NonNullable<WebClientOptions["fetch"]> = async (input, init) => {
    const url = new URL(String(input));
    if (typeof init?.body !== "string") {
      throw new Error("Expected a form-encoded Slack request body");
    }
    const args = Object.fromEntries(new URLSearchParams(init.body));
    const method = url.pathname.split("/").at(-1) ?? "";
    requests.push({ method, args, authorization: new Headers(init?.headers).get("authorization") });
    const response =
      method === "conversations.open"
        ? (openResponse ?? { ok: true, channel: { id: conversationId } })
        : method === "chat.postMessage"
          ? { ok: true, channel: args.channel, ts: "171234.567", message: { text: args.text } }
          : undefined;
    if (!response) {
      throw new Error(`Unexpected Slack request: ${method}`);
    }
    return new Response(JSON.stringify(response), {
      headers: { "content-type": "application/json" },
    });
  };
  vi.spyOn(slackClient, "getSlackWriteClient").mockImplementation(
    (token, options) => new WebClient(token, { ...options, fetch, retryConfig: { retries: 0 } }),
  );
  vi.spyOn(slackClient, "createSlackLookupClient").mockImplementation(() => {
    throw new Error("Opening and sending must not use the read client");
  });
  const adapter = createSlackActions("slack");
  const invoke = (
    action: ChannelMessageActionName,
    params: Record<string, unknown>,
    overrides: Partial<ChannelMessageActionContext> = {},
  ) =>
    adapter.handleAction!({
      channel: "slack",
      action,
      cfg,
      params,
      accountId: "default",
      requesterAccountId: "default",
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "team:T11111111:channel:C09999999",
        currentThreadTs: "170000.111",
        replyToMode: "all",
      },
      ...overrides,
    });
  return { adapter, cfg, invoke, requests };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Slack conversation-open", () => {
  it("exposes the recipient contract to the message tool", () => {
    const { adapter, cfg } = createConversationFixture();
    const discovery = adapter.describeMessageTool({ cfg, accountId: "default" });
    expect(discovery?.actions).toContain("conversation-open");
    const contributions = discovery?.schema;
    const schema = (Array.isArray(contributions) ? contributions : [contributions]).find((entry) =>
      entry?.actions?.includes("conversation-open"),
    );
    expect(schema?.properties.userIds).toMatchObject({ type: "array", minItems: 1, maxItems: 8 });
  });

  it.each(["C01234567", "G01234567"])(
    "opens one group DM and sends to its returned %s target as the bot",
    async (channelId) => {
      const { invoke, requests } = createConversationFixture(channelId);
      const opened = await invoke("conversation-open", { userIds: ["U11111111", "U22222222"] });
      const target = `team:T11111111:channel:${channelId}`;
      expect(opened.details).toEqual({ ok: true, channelId, target });
      expect(requests).toEqual([
        {
          method: "conversations.open",
          args: { users: "U11111111,U22222222", team_id: "T11111111" },
          authorization: "Bearer xoxb-test",
        },
      ]);

      await invoke("send", { to: target, message: "Hello together" });
      expect(requests.map((request) => request.method)).toEqual([
        "conversations.open",
        "chat.postMessage",
      ]);
      expect(requests[1]).toMatchObject({
        authorization: "Bearer xoxb-test",
        args: { channel: channelId, text: "Hello together", team_id: "T11111111" },
      });
      expect(requests[1]?.args).not.toHaveProperty("thread_ts");
    },
  );

  it("opens a one-to-one DM without requiring a current conversation", async () => {
    const { invoke, requests } = createConversationFixture("D01234567");
    const installation = registerSlackInstallationState("default", "workspace");
    try {
      const opened = await invoke(
        "conversation-open",
        { userIds: ["U11111111"] },
        { toolContext: undefined },
      );
      expect(opened.details).toEqual({
        ok: true,
        channelId: "D01234567",
        target: "channel:D01234567",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.args).toEqual({ users: "U11111111" });
    } finally {
      installation.release();
    }
  });

  it("accepts eight recipients, including legacy W-prefixed user IDs", async () => {
    const { invoke, requests } = createConversationFixture();
    const userIds = ["W11111111", ...Array.from({ length: 7 }, (_, index) => `U2222222${index}`)];
    await invoke("conversation-open", { userIds });
    expect(requests[0]?.args.users).toBe(userIds.join(","));
  });

  it.each([
    { name: "missing recipients", userIds: undefined },
    { name: "no recipients", userIds: [] },
    { name: "a comma-separated string", userIds: "U11111111,U22222222" },
    { name: "a channel ID", userIds: ["C11111111"] },
    { name: "a mention", userIds: ["<@U11111111>"] },
    { name: "duplicate recipients", userIds: ["U11111111", "U11111111"] },
    { name: "duplicates after trimming", userIds: ["U11111111", " U11111111 "] },
    {
      name: "too many recipients",
      userIds: Array.from({ length: 9 }, (_, index) => `U1111111${index}`),
    },
  ])("rejects $name before calling Slack", async ({ userIds }) => {
    const { invoke, requests } = createConversationFixture();
    await expect(invoke("conversation-open", { userIds })).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it("honors the messages action gate in discovery and execution", async () => {
    const { adapter, cfg, invoke, requests } = createConversationFixture();
    cfg.channels!.slack!.actions = { messages: false };
    expect(adapter.describeMessageTool({ cfg, accountId: "default" })?.actions).not.toContain(
      "conversation-open",
    );
    await expect(
      invoke("conversation-open", { userIds: ["U11111111", "U22222222"] }),
    ).rejects.toThrow("Slack messages are disabled");
    expect(requests).toEqual([]);
  });

  it("does not grant group-DM read access or change inbound policy", async () => {
    const { cfg, invoke, requests } = createConversationFixture();
    cfg.channels!.slack!.dm = { groupEnabled: false, groupChannels: ["G99999999"] };
    const policy = structuredClone(cfg);
    await invoke("conversation-open", { userIds: ["U11111111", "U22222222"] });
    expect(requests.map((request) => request.method)).toEqual(["conversations.open"]);
    expect(requests[0]?.args).not.toHaveProperty("return_im");
    expect(cfg).toEqual(policy);
  });

  it("does not fall back to a user read token when the bot token is missing", async () => {
    const { adapter, cfg, invoke, requests } = createConversationFixture();
    vi.stubEnv("SLACK_BOT_TOKEN", undefined);
    cfg.channels!.slack!.botToken = undefined;
    expect(adapter.describeMessageTool({ cfg, accountId: "default" })?.actions).not.toContain(
      "conversation-open",
    );
    await expect(invoke("conversation-open", { userIds: ["U11111111"] })).rejects.toThrow(
      "botToken is required",
    );
    expect(requests).toEqual([]);
  });

  it("uses the user token only for an explicitly configured user identity", async () => {
    const { cfg, invoke, requests } = createConversationFixture();
    cfg.channels!.slack!.postAs = "user";
    await invoke("conversation-open", { userIds: ["U11111111", "U22222222"] });
    expect(requests[0]?.authorization).toBe("Bearer xoxp-readonly");
  });

  it.each([
    { name: "detached", overrides: { toolContext: undefined } },
    { name: "cross-account", overrides: { requesterAccountId: "another-account" } },
    {
      name: "conflicting-workspace",
      overrides: {
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "team:T11111111:channel:C09999999",
          currentMessagingTarget: "team:T22222222:channel:C09999999",
        },
      },
    },
  ])("requires an explicit workspace for $name Enterprise calls", async ({ overrides }) => {
    const { invoke, requests } = createConversationFixture();
    const installation = registerSlackInstallationState("default", "enterprise");
    try {
      await expect(
        invoke("conversation-open", { userIds: ["U11111111", "U22222222"] }, overrides),
      ).rejects.toThrow("unsupported_enterprise_slack_delivery");
      expect(requests).toEqual([]);
    } finally {
      installation.release();
    }
  });

  it("preserves an explicit workspace on detached Enterprise calls", async () => {
    const { invoke, requests } = createConversationFixture();
    const installation = registerSlackInstallationState("default", "enterprise");
    try {
      const opened = await invoke(
        "conversation-open",
        { userIds: ["U11111111", "U22222222"], teamId: "T22222222" },
        { toolContext: undefined },
      );
      expect(opened.details).toEqual({
        ok: true,
        channelId: "C01234567",
        target: "team:T22222222:channel:C01234567",
      });
      expect(requests[0]?.args.team_id).toBe("T22222222");
    } finally {
      installation.release();
    }
  });

  it("rejects a malformed explicit workspace before calling Slack", async () => {
    const { invoke, requests } = createConversationFixture();
    await expect(
      invoke("conversation-open", { userIds: ["U11111111"], teamId: "U11111111" }),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it.each([
    { response: { ok: false, error: "missing_scope" }, error: "missing_scope" },
    { response: { ok: true, channel: {} }, error: "valid conversation ID" },
    { response: { ok: true, channel: { id: "U11111111" } }, error: "valid conversation ID" },
  ])("reports Slack failures without sending a message: $error", async ({ response, error }) => {
    const { invoke, requests } = createConversationFixture("C01234567", response);
    await expect(
      invoke("conversation-open", { userIds: ["U11111111", "U22222222"] }),
    ).rejects.toThrow(error);
    expect(requests.map((request) => request.method)).toEqual(["conversations.open"]);
  });
});
