import { describe, expect, it, vi } from "vitest";
import { handleSlackMessageAction } from "./message-action-dispatch.js";

function createInvokeSpy() {
  return vi.fn(async (action: Record<string, unknown>, _cfg?: unknown, _toolContext?: unknown) => ({
    ok: true,
    content: action,
  }));
}

function slackConfig() {
  return { channels: { slack: { botToken: "tok" } } };
}

function firstInvokeCall(invoke: ReturnType<typeof createInvokeSpy>) {
  const [call] = invoke.mock.calls;
  if (!call) {
    throw new Error("expected first Slack action invoke");
  }
  return call;
}

function expectForwardedCfg(invoke: ReturnType<typeof createInvokeSpy>, cfg: unknown) {
  expect(firstInvokeCall(invoke)[1]).toBe(cfg);
}

function expectNoForwardedToolContext(invoke: ReturnType<typeof createInvokeSpy>) {
  expect(firstInvokeCall(invoke)[2]).toBeUndefined();
}

function firstAction(invoke: ReturnType<typeof createInvokeSpy>) {
  const action = firstInvokeCall(invoke)[0];
  if (!action || typeof action !== "object") {
    throw new Error("expected first invoke action");
  }
  return action;
}

function blockAt(action: Record<string, unknown>, index: number) {
  const blocks = action.blocks as Array<Record<string, unknown>> | undefined;
  const block = blocks?.[index];
  if (!block) {
    throw new Error(`expected Slack block ${index}`);
  }
  return block;
}

function elementAt(block: Record<string, unknown>, index: number) {
  const elements = block.elements as Array<Record<string, unknown>> | undefined;
  const element = elements?.[index];
  if (!element) {
    throw new Error(`expected Slack block element ${index}`);
  }
  return element;
}

describe("handleSlackMessageAction", () => {
  it("merges presentation and interactive blocks when sending", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "send",
        cfg: {},
        params: {
          to: "channel:C1",
          message: "Deploy?",
          presentation: {
            blocks: [{ type: "text", text: "Deploy summary" }],
          },
          interactive: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Approve", value: "approve" }],
              },
            ],
          },
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(blockAt(action, 0).type).toBe("section");
    const actionsBlock = blockAt(action, 1);
    expect(actionsBlock.type).toBe("actions");
    expect(elementAt(actionsBlock, 0).value).toBe("approve");
  });

  it("keeps generated Slack control ids unique when presentation and interactive controls are merged", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "send",
        cfg: {},
        params: {
          to: "channel:C1",
          message: "Deploy?",
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Stage", value: "stage" }],
              },
            ],
          },
          interactive: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Approve", value: "approve" }],
              },
            ],
          },
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    const firstButtons = blockAt(action, 0);
    expect(firstButtons.block_id).toBe("openclaw_reply_buttons_1");
    expect(elementAt(firstButtons, 0).action_id).toBe("openclaw:reply_button:1:1");
    const secondButtons = blockAt(action, 1);
    expect(secondButtons.block_id).toBe("openclaw_reply_buttons_2");
    expect(elementAt(secondButtons, 0).action_id).toBe("openclaw:reply_button:2:1");
  });

  it("passes media and rendered interactive blocks through for split Slack delivery", async () => {
    const invoke = createInvokeSpy();
    const cfg = slackConfig();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "send",
        cfg,
        params: {
          to: "channel:C1",
          message: "Approval required",
          media: "https://example.com/report.md",
          interactive: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Approve", value: "approve" }],
              },
            ],
          },
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledOnce();
    const action = firstAction(invoke);
    expect(action.action).toBe("sendMessage");
    expect(action.to).toBe("channel:C1");
    expect(action.content).toBe("Approval required");
    expect(action.mediaUrl).toBe("https://example.com/report.md");
    const actionsBlock = blockAt(action, 0);
    expect(actionsBlock.type).toBe("actions");
    expect(elementAt(actionsBlock, 0).value).toBe("approve");
    expectForwardedCfg(invoke, cfg);
    expectNoForwardedToolContext(invoke);
  });

  it("passes replyBroadcast through for Slack thread sends", async () => {
    const invoke = createInvokeSpy();
    const cfg = slackConfig();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "send",
        cfg,
        params: {
          to: "channel:C1",
          message: "Visible from the channel",
          threadId: "111.222",
          replyBroadcast: true,
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(action.action).toBe("sendMessage");
    expect(action.to).toBe("channel:C1");
    expect(action.content).toBe("Visible from the channel");
    expect(action.threadTs).toBe("111.222");
    expect(action.replyBroadcast).toBe(true);
    expectForwardedCfg(invoke, cfg);
    expectNoForwardedToolContext(invoke);
  });

  it("passes topLevel through so same-channel Slack sends can suppress thread inheritance", async () => {
    const invoke = createInvokeSpy();
    const cfg = slackConfig();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "send",
        cfg,
        params: {
          to: "channel:C1",
          message: "Visible in the parent channel",
          topLevel: true,
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(action.action).toBe("sendMessage");
    expect(action.to).toBe("channel:C1");
    expect(action.content).toBe("Visible in the parent channel");
    expect(action.threadTs).toBeUndefined();
    expect(action.topLevel).toBe(true);
    expectForwardedCfg(invoke, cfg);
    expectNoForwardedToolContext(invoke);
  });

  it("treats threadId null as a Slack top-level send request", async () => {
    const invoke = createInvokeSpy();
    const cfg = slackConfig();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "send",
        cfg,
        params: {
          to: "channel:C1",
          message: "Visible in the parent channel",
          threadId: null,
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(action.action).toBe("sendMessage");
    expect(action.threadTs).toBeUndefined();
    expect(action.topLevel).toBe(true);
    expectForwardedCfg(invoke, cfg);
    expectNoForwardedToolContext(invoke);
  });

  it("maps upload-file to the internal uploadFile action", async () => {
    const invoke = createInvokeSpy();
    const cfg = slackConfig();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "upload-file",
        cfg,
        params: {
          to: "user:U1",
          filePath: "/tmp/report.png",
          initialComment: "fresh build",
          filename: "build.png",
          title: "Build Screenshot",
          threadId: "111.222",
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(action.action).toBe("uploadFile");
    expect(action.to).toBe("user:U1");
    expect(action.filePath).toBe("/tmp/report.png");
    expect(action.initialComment).toBe("fresh build");
    expect(action.filename).toBe("build.png");
    expect(action.title).toBe("Build Screenshot");
    expect(action.threadTs).toBe("111.222");
    expectForwardedCfg(invoke, cfg);
    expectNoForwardedToolContext(invoke);
  });

  it("rejects replyBroadcast for upload-file", async () => {
    await expect(
      handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "upload-file",
          cfg: {},
          params: {
            to: "channel:C1",
            filePath: "/tmp/report.png",
            threadId: "111.222",
            replyBroadcast: true,
          },
        } as never,
        invoke: createInvokeSpy() as never,
      }),
    ).rejects.toThrow(/replyBroadcast is only supported for text or block thread replies/i);
  });

  it("maps upload-file aliases to upload params", async () => {
    const invoke = createInvokeSpy();
    const cfg = slackConfig();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "upload-file",
        cfg,
        params: {
          channelId: "C1",
          media: "/tmp/chart.png",
          message: "chart attached",
          replyTo: "333.444",
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(action.action).toBe("uploadFile");
    expect(action.to).toBe("C1");
    expect(action.filePath).toBe("/tmp/chart.png");
    expect(action.initialComment).toBe("chart attached");
    expect(action.threadTs).toBe("333.444");
    expectForwardedCfg(invoke, cfg);
    expectNoForwardedToolContext(invoke);
  });

  it("maps upload-file path alias to filePath", async () => {
    const invoke = createInvokeSpy();
    const cfg = slackConfig();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "upload-file",
        cfg,
        params: {
          to: "channel:C1",
          path: "/tmp/report.txt",
          initialComment: "path alias",
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(action.action).toBe("uploadFile");
    expect(action.to).toBe("channel:C1");
    expect(action.filePath).toBe("/tmp/report.txt");
    expect(action.initialComment).toBe("path alias");
    expectForwardedCfg(invoke, cfg);
    expectNoForwardedToolContext(invoke);
  });

  it("forwards messageId for read actions", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "read",
        cfg: {},
        params: {
          channelId: "C1",
          messageId: "1712345678.654321",
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(action.action).toBe("readMessages");
    expect(action.channelId).toBe("C1");
    expect(action.messageId).toBe("1712345678.654321");
    expect(firstInvokeCall(invoke)[1]).toEqual({});
  });

  it("requires filePath, path, or media for upload-file", async () => {
    await expect(
      handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "upload-file",
          cfg: {},
          params: {
            to: "channel:C1",
          },
        } as never,
        invoke: createInvokeSpy() as never,
      }),
    ).rejects.toThrow(/upload-file requires filePath, path, or media/i);
  });

  it("maps download-file to the internal downloadFile action", async () => {
    const invoke = createInvokeSpy();
    const cfg = slackConfig();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "download-file",
        cfg,
        params: {
          channelId: "C1",
          fileId: "F123",
          threadId: "111.222",
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(action.action).toBe("downloadFile");
    expect(action.fileId).toBe("F123");
    expect(action.channelId).toBe("C1");
    expect(action.threadId).toBe("111.222");
    expectForwardedCfg(invoke, cfg);
  });

  it("maps download-file target aliases to scope fields", async () => {
    const invoke = createInvokeSpy();
    const cfg = slackConfig();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "download-file",
        cfg,
        params: {
          to: "channel:C2",
          fileId: "F999",
          replyTo: "333.444",
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(action.action).toBe("downloadFile");
    expect(action.fileId).toBe("F999");
    expect(action.channelId).toBe("channel:C2");
    expect(action.threadId).toBe("333.444");
    expectForwardedCfg(invoke, cfg);
  });

  it("explains that download-file requires fileId, not messageId", async () => {
    await expect(
      handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "download-file",
          cfg: {},
          params: {
            channelId: "C1",
            messageId: "1777423717.666499",
          },
        } as never,
        invoke: createInvokeSpy() as never,
      }),
    ).rejects.toThrow(/Did you mean to pass fileId/i);
  });

  it("explains that download-file requires fileId for message_id aliases", async () => {
    await expect(
      handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "download-file",
          cfg: {},
          params: {
            channelId: "C1",
            message_id: "1777423717.666499",
          },
        } as never,
        invoke: createInvokeSpy() as never,
      }),
    ).rejects.toThrow(/Did you mean to pass fileId/i);
  });

  it("keeps the generic fileId requirement when no message id was supplied", async () => {
    await expect(
      handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "download-file",
          cfg: {},
          params: {
            channelId: "C1",
          },
        } as never,
        invoke: createInvokeSpy() as never,
      }),
    ).rejects.toThrow(/fileId/i);
  });
});
