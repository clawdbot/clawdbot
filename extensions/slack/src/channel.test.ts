import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import { slackPlugin } from "./channel.js";
import { slackOutbound } from "./outbound-adapter.js";
import * as probeModule from "./probe.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { clearSlackRuntime, setSlackRuntime } from "./runtime.js";

const { handleSlackActionMock } = vi.hoisted(() => ({
  handleSlackActionMock: vi.fn(),
}));
const { sendMessageSlackMock } = vi.hoisted(() => ({
  sendMessageSlackMock: vi.fn(),
}));

vi.mock("./action-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./action-runtime.js")>("./action-runtime.js");
  return {
    ...actual,
    handleSlackAction: handleSlackActionMock,
  };
});

vi.mock("./send.runtime.js", () => ({
  sendMessageSlack: sendMessageSlackMock,
}));

beforeEach(async () => {
  handleSlackActionMock.mockReset();
  sendMessageSlackMock.mockReset();
  sendMessageSlackMock.mockResolvedValue({ messageId: "msg-1", channelId: "D123" });
  setSlackRuntime({
    channel: {
      slack: {
        handleSlackAction: handleSlackActionMock,
      },
    },
  } as never);
});

async function getSlackConfiguredState(cfg: OpenClawConfig) {
  const account = slackPlugin.config.resolveAccount(cfg, "default");
  return {
    configured: slackPlugin.config.isConfigured?.(account, cfg),
    snapshot: await slackPlugin.status?.buildAccountSnapshot?.({
      account,
      cfg,
      runtime: undefined,
    }),
  };
}

function requireSlackHandleAction() {
  const handleAction = slackPlugin.actions?.handleAction;
  if (!handleAction) {
    throw new Error("slack actions.handleAction unavailable");
  }
  return handleAction;
}

function requireSlackSendText() {
  const sendText = slackPlugin.outbound?.sendText;
  if (!sendText) {
    throw new Error("slack outbound.sendText unavailable");
  }
  return sendText;
}

function requireSlackSendMedia() {
  const sendMedia = slackPlugin.outbound?.sendMedia;
  if (!sendMedia) {
    throw new Error("slack outbound.sendMedia unavailable");
  }
  return sendMedia;
}

function requireSlackSendPayload() {
  const sendPayload = slackPlugin.outbound?.sendPayload ?? slackOutbound.sendPayload;
  if (!sendPayload) {
    throw new Error("slack outbound.sendPayload unavailable");
  }
  return sendPayload;
}

function requireSlackListPeers() {
  const listPeers = slackPlugin.directory?.listPeers;
  if (!listPeers) {
    throw new Error("slack directory.listPeers unavailable");
  }
  return listPeers;
}

describe("slackPlugin actions", () => {
  it("prefers session lookup for announce target routing", () => {
    expect(slackPlugin.meta.preferSessionLookupForAnnounceTarget).toBe(true);
  });

  it("owns unified message tool discovery", () => {
    const discovery = slackPlugin.actions?.describeMessageTool({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
            capabilities: { interactiveReplies: true },
          },
        },
      },
    });

    expect(discovery?.actions).toContain("send");
    expect(discovery?.capabilities).toEqual(expect.arrayContaining(["blocks", "interactive"]));
    expect(discovery?.schema).toMatchObject({
      properties: {
        blocks: expect.any(Object),
      },
    });
  });

  it("honors the selected Slack account during message tool discovery", () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          botToken: "xoxb-root",
          appToken: "xapp-root",
          actions: {
            reactions: false,
            messages: false,
            pins: false,
            memberInfo: false,
            emojiList: false,
          },
          capabilities: {
            interactiveReplies: false,
          },
          accounts: {
            default: {
              botToken: "xoxb-default",
              appToken: "xapp-default",
              actions: {
                reactions: false,
                messages: false,
                pins: false,
                memberInfo: false,
                emojiList: false,
              },
              capabilities: {
                interactiveReplies: false,
              },
            },
            work: {
              botToken: "xoxb-work",
              appToken: "xapp-work",
              actions: {
                reactions: true,
                messages: true,
                pins: false,
                memberInfo: false,
                emojiList: false,
              },
              capabilities: {
                interactiveReplies: true,
              },
            },
          },
        },
      },
    };

    expect(slackPlugin.actions?.describeMessageTool?.({ cfg, accountId: "default" })).toMatchObject(
      {
        actions: ["send"],
        capabilities: ["blocks"],
      },
    );
    expect(slackPlugin.actions?.describeMessageTool?.({ cfg, accountId: "work" })).toMatchObject({
      actions: [
        "send",
        "react",
        "reactions",
        "read",
        "edit",
        "delete",
        "download-file",
        "upload-file",
      ],
      capabilities: expect.arrayContaining(["blocks", "interactive"]),
    });
  });

  it("uses configured defaultAccount for pairing approval notifications", async () => {
    const cfg = {
      channels: {
        slack: {
          defaultAccount: "work",
          accounts: {
            work: {
              botToken: "xoxb-work",
            },
          },
        },
      },
    } as OpenClawConfig;
    setSlackRuntime({
      config: {
        loadConfig: () => cfg,
      },
    } as never);

    const notify = slackPlugin.pairing?.notifyApproval;
    if (!notify) {
      throw new Error("slack pairing notify unavailable");
    }

    await notify({
      cfg,
      id: "U12345678",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "user:U12345678",
      expect.stringContaining("approved"),
    );
  });

  it("keeps blocks optional in the message tool schema", () => {
    const discovery = slackPlugin.actions?.describeMessageTool({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
          },
        },
      } as OpenClawConfig,
    });
    const schema = discovery?.schema;
    if (!schema || Array.isArray(schema)) {
      throw new Error("expected slack message-tool schema");
    }

    expect(Type.Object(schema.properties).required).toBeUndefined();
  });

  it("treats interactive reply payloads as structured Slack payloads", () => {
    const hasStructuredReplyPayload = slackPlugin.messaging?.hasStructuredReplyPayload;
    if (!hasStructuredReplyPayload) {
      throw new Error("slack messaging.hasStructuredReplyPayload unavailable");
    }

    expect(
      hasStructuredReplyPayload({
        payload: {
          text: "Choose",
          interactive: {
            blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "retry" }] }],
          },
        },
      }),
    ).toBe(true);
  });

  it("forwards read threadId to Slack action handler", async () => {
    handleSlackActionMock.mockResolvedValueOnce({ messages: [], hasMore: false });
    const handleAction = requireSlackHandleAction();

    await handleAction({
      action: "read",
      channel: "slack",
      accountId: "default",
      cfg: {},
      params: {
        channelId: "C123",
        threadId: "1712345678.123456",
      },
    });

    expect(handleSlackActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "readMessages",
        channelId: "C123",
        threadId: "1712345678.123456",
      }),
      {},
      undefined,
    );
  });
});

describe("slackPlugin status", () => {
  it("uses the direct Slack probe helper when runtime is not initialized", async () => {
    const probeSpy = vi.spyOn(probeModule, "probeSlack").mockResolvedValueOnce({
      ok: true,
      status: 200,
      bot: { id: "B1", name: "openclaw-bot" },
      team: { id: "T1", name: "OpenClaw" },
    });
    clearSlackRuntime();
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
        },
      },
    } as OpenClawConfig;
    const account = slackPlugin.config.resolveAccount(cfg, "default");

    const result = await slackPlugin.status!.probeAccount!({
      account,
      timeoutMs: 2500,
      cfg,
    });

    expect(probeSpy).toHaveBeenCalledWith("xoxb-test", 2500);
    expect(result).toEqual({
      ok: true,
      status: 200,
      bot: { id: "B1", name: "openclaw-bot" },
      team: { id: "T1", name: "OpenClaw" },
    });
  });
});

describe("slackPlugin security", () => {
  it("normalizes dm allowlist entries with trimmed prefixes", () => {
    const resolveDmPolicy = slackPlugin.security?.resolveDmPolicy;
    if (!resolveDmPolicy) {
      throw new Error("resolveDmPolicy unavailable");
    }

    const result = resolveDmPolicy({
      cfg: {
        channels: {
          slack: {
            dm: { policy: "allowlist", allowFrom: ["  slack:U123  "] },
          },
        },
      } as OpenClawConfig,
      account: slackPlugin.config.resolveAccount(
        {
          channels: {
            slack: {
              botToken: "xoxb-test",
              appToken: "xapp-test",
              dm: { policy: "allowlist", allowFrom: ["  slack:U123  "] },
            },
          },
        } as OpenClawConfig,
        "default",
      ),
    });
    if (!result) {
      throw new Error("slack resolveDmPolicy returned null");
    }

    expect(result.policy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["  slack:U123  "]);
    expect(result.normalizeEntry?.("  slack:U123  ")).toBe("U123");
    expect(result.normalizeEntry?.("  user:U999  ")).toBe("U999");
  });
});

describe("slackPlugin outbound", () => {
  const cfg = {
    channels: {
      slack: {
        botToken: "xoxb-test",
        appToken: "xapp-test",
      },
    },
  };

  it("treats ACP block text as visible delivered output", () => {
    expect(
      slackPlugin.outbound?.shouldTreatDeliveredTextAsVisible?.({
        kind: "block",
        text: "hello",
      }),
    ).toBe(true);
    expect(
      slackPlugin.outbound?.shouldTreatDeliveredTextAsVisible?.({
        kind: "tool",
        text: "hello",
      }),
    ).toBe(false);
  });

  it("advertises the 8000-character Slack default chunk limit", () => {
    expect(slackOutbound.textChunkLimit).toBe(8000);
    expect(slackPlugin.outbound?.textChunkLimit).toBe(8000);
  });

  it("uses threadId as threadTs fallback for sendText", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-text" });
    const sendText = requireSlackSendText();

    const result = await sendText({
      cfg,
      to: "C123",
      text: "hello",
      accountId: "default",
      threadId: "1712345678.123456",
      deps: { sendSlack },
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "C123",
      "hello",
      expect.objectContaining({
        threadTs: "1712345678.123456",
      }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-text" });
  });

  it("prefers replyToId over threadId for sendMedia", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-media" });
    const sendMedia = requireSlackSendMedia();

    const result = await sendMedia({
      cfg,
      to: "C999",
      text: "caption",
      mediaUrl: "https://example.com/image.png",
      accountId: "default",
      replyToId: "1712000000.000001",
      threadId: "1712345678.123456",
      deps: { sendSlack },
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "C999",
      "caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/image.png",
        threadTs: "1712000000.000001",
      }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-media" });
  });

  it("forwards mediaLocalRoots for sendMedia", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-media-local" });
    const sendMedia = requireSlackSendMedia();
    const mediaLocalRoots = ["/tmp/workspace"];

    const result = await sendMedia({
      cfg,
      to: "C999",
      text: "caption",
      mediaUrl: "/tmp/workspace/image.png",
      mediaLocalRoots,
      accountId: "default",
      deps: { sendSlack },
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "C999",
      "caption",
      expect.objectContaining({
        mediaUrl: "/tmp/workspace/image.png",
        mediaLocalRoots,
      }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-media-local" });
  });

  it("sends block payload media first, then the final block message", async () => {
    const sendSlack = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "m-media-1" })
      .mockResolvedValueOnce({ messageId: "m-media-2" })
      .mockResolvedValueOnce({ messageId: "m-final" });
    const sendPayload = requireSlackSendPayload();

    const result = await sendPayload({
      cfg,
      to: "C999",
      text: "",
      payload: {
        text: "hello",
        mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
        channelData: {
          slack: {
            blocks: [
              {
                type: "section",
                text: {
                  type: "plain_text",
                  text: "Block body",
                },
              },
            ],
          },
        },
      },
      accountId: "default",
      deps: { sendSlack },
      mediaLocalRoots: ["/tmp/media"],
    });

    expect(sendSlack).toHaveBeenCalledTimes(3);
    expect(sendSlack).toHaveBeenNthCalledWith(
      1,
      "C999",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/1.png",
        mediaLocalRoots: ["/tmp/media"],
      }),
    );
    expect(sendSlack).toHaveBeenNthCalledWith(
      2,
      "C999",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/2.png",
        mediaLocalRoots: ["/tmp/media"],
      }),
    );
    expect(sendSlack).toHaveBeenNthCalledWith(
      3,
      "C999",
      "hello",
      expect.objectContaining({
        blocks: [
          {
            type: "section",
            text: {
              type: "plain_text",
              text: "Block body",
            },
          },
        ],
      }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-final" });
  });

  it("renders shared interactive payloads into Slack Block Kit via plugin outbound", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-interactive" });
    const sendPayload = requireSlackSendPayload();

    const result = await sendPayload({
      cfg,
      to: "user:U123",
      text: "",
      payload: {
        text: "Slack interactive smoke.",
        interactive: {
          blocks: [
            {
              type: "text",
              text: "Slack interactive smoke.",
            },
            {
              type: "buttons",
              buttons: [
                { label: "Approve", value: "approve" },
                { label: "Reject", value: "reject" },
              ],
            },
            {
              type: "select",
              placeholder: "Choose a target",
              options: [
                { label: "Canary", value: "canary" },
                { label: "Production", value: "production" },
              ],
            },
          ],
        },
      },
      accountId: "default",
      deps: { sendSlack },
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "user:U123",
      "Slack interactive smoke.",
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            type: "section",
          }),
          expect.objectContaining({
            type: "actions",
            elements: [
              expect.objectContaining({ type: "button", value: "approve" }),
              expect.objectContaining({ type: "button", value: "reject" }),
            ],
          }),
          expect.objectContaining({
            type: "actions",
            elements: [
              expect.objectContaining({
                type: "static_select",
                options: [
                  expect.objectContaining({ value: "canary" }),
                  expect.objectContaining({ value: "production" }),
                ],
              }),
            ],
          }),
        ],
      }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-interactive" });
  });
});

describe("slackPlugin directory", () => {
  it("lists configured peers without throwing a ReferenceError", async () => {
    const listPeers = requireSlackListPeers();

    await expect(
      listPeers({
        cfg: {
          channels: {
            slack: {
              dms: {
                U123: {},
              },
            },
          },
        },
        runtime: createRuntimeEnv(),
      }),
    ).resolves.toEqual([{ id: "user:u123", kind: "user" }]);
  });
});

describe("slackPlugin agentPrompt", () => {
  it("tells agents interactive replies are disabled by default", () => {
    const hints = slackPlugin.agentPrompt?.messageToolHints?.({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
          },
        },
      },
    });

    expect(hints).toEqual([
      "- Slack interactive replies are disabled. If needed, ask to set `channels.slack.capabilities.interactiveReplies=true` (or the same under `channels.slack.accounts.<account>.capabilities`).",
    ]);
  });

  it("shows Slack interactive reply directives when enabled", () => {
    const hints = slackPlugin.agentPrompt?.messageToolHints?.({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
            capabilities: { interactiveReplies: true },
          },
        },
      },
    });

    expect(hints).toContain(
      "- Prefer Slack buttons/selects for 2-5 discrete choices or parameter picks instead of asking the user to type one.",
    );
    expect(hints).toContain(
      "- Slack interactive replies: use `[[slack_buttons: Label:value, Other:other]]` to add action buttons that route clicks back as Slack interaction system events.",
    );
    expect(hints).toContain(
      "- Slack selects: use `[[slack_select: Placeholder | Label:value, Other:other]]` to add a static select menu that routes the chosen value back as a Slack interaction system event.",
    );
  });
});

describe("slackPlugin outbound new targets", () => {
  const cfg = {
    channels: {
      slack: {
        botToken: "xoxb-test",
        appToken: "xapp-test",
      },
    },
  };

  it("sends to a new user target via DM without erroring", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-new-user", channelId: "D999" });
    const sendText = requireSlackSendText();

    const result = await sendText({
      cfg,
      to: "user:U99NEW",
      text: "hello new user",
      accountId: "default",
      deps: { sendSlack },
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "user:U99NEW",
      "hello new user",
      expect.objectContaining({ cfg }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-new-user", channelId: "D999" });
  });

  it("sends to a new channel target without erroring", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-new-chan", channelId: "C555" });
    const sendText = requireSlackSendText();

    const result = await sendText({
      cfg,
      to: "channel:C555NEW",
      text: "hello channel",
      accountId: "default",
      deps: { sendSlack },
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "channel:C555NEW",
      "hello channel",
      expect.objectContaining({ cfg }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-new-chan", channelId: "C555" });
  });

  it("sends media to a new user target without erroring", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-new-media", channelId: "D888" });
    const sendMedia = requireSlackSendMedia();

    const result = await sendMedia({
      cfg,
      to: "user:U88NEW",
      text: "here is a file",
      mediaUrl: "https://example.com/file.png",
      accountId: "default",
      deps: { sendSlack },
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "user:U88NEW",
      "here is a file",
      expect.objectContaining({
        cfg,
        mediaUrl: "https://example.com/file.png",
      }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-new-media", channelId: "D888" });
  });
});

describe("slackPlugin config", () => {
  it("treats HTTP mode accounts with bot token + signing secret as configured", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          mode: "http",
          botToken: "xoxb-http",
          signingSecret: "secret-http", // pragma: allowlist secret
        },
      },
    };

    const { configured, snapshot } = await getSlackConfiguredState(cfg);

    expect(configured).toBe(true);
    expect(snapshot?.configured).toBe(true);
  });

  it("keeps socket mode requiring app token", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          mode: "socket",
          botToken: "xoxb-socket",
        },
      },
    };

    const { configured, snapshot } = await getSlackConfiguredState(cfg);

    expect(configured).toBe(false);
    expect(snapshot?.configured).toBe(false);
  });

  it("does not mark partial configured-unavailable token status as configured", async () => {
    const snapshot = await slackPlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        name: "Default",
        enabled: true,
        configured: false,
        botTokenStatus: "configured_unavailable",
        appTokenStatus: "missing",
        botTokenSource: "config",
        appTokenSource: "none",
        config: {},
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
    });

    expect(snapshot?.configured).toBe(false);
    expect(snapshot?.botTokenStatus).toBe("configured_unavailable");
    expect(snapshot?.appTokenStatus).toBe("missing");
  });

  it("keeps HTTP mode signing-secret unavailable accounts configured in snapshots", async () => {
    const snapshot = await slackPlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        name: "Default",
        enabled: true,
        configured: true,
        mode: "http",
        botTokenStatus: "available",
        signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
        botTokenSource: "config",
        signingSecretSource: "config", // pragma: allowlist secret
        config: {
          mode: "http",
          botToken: "xoxb-http",
          signingSecret: { source: "env", provider: "default", id: "SLACK_SIGNING_SECRET" },
        },
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
    });

    expect(snapshot?.configured).toBe(true);
    expect(snapshot?.botTokenStatus).toBe("available");
    expect(snapshot?.signingSecretStatus).toBe("configured_unavailable");
  });
});
