// Slack tests cover message action dispatch plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { handleSlackMessageAction } from "./message-action-dispatch.js";
import { extractSlackToolSend } from "./message-actions.js";
import { renderSlackMessagePresentationFallbackText } from "./presentation-fallback.js";

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

function preparedMessages(invoke: ReturnType<typeof createInvokeSpy>) {
  const context = firstInvokeCall(invoke)[2] as
    | { preparedMessages?: Array<Record<string, unknown>> }
    | undefined;
  const messages = context?.preparedMessages;
  if (!messages?.length) {
    throw new Error("expected prepared Slack messages");
  }
  return messages;
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

function largeTablePresentation() {
  return {
    blocks: [
      {
        type: "table",
        caption: "Large pipeline",
        headers: ["Account"],
        rows: Array.from({ length: 100 }, (_entry, index) => [
          index === 0 ? "<@U123>" : `account-${String(index)} ${"x".repeat(110)}`,
        ]),
      },
    ],
  };
}

describe("handleSlackMessageAction", () => {
  it("defaults reactions to the current inbound Slack message", async () => {
    const invoke = createInvokeSpy();
    const toolContext = { currentMessageId: "171234.567" };

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "react",
        cfg: {},
        params: {
          channelId: "C1",
          emoji: "✅",
        },
        toolContext,
      } as never,
      invoke: invoke as never,
    });

    expect(firstAction(invoke)).toMatchObject({
      action: "react",
      channelId: "C1",
      emoji: "✅",
      messageId: "171234.567",
    });
    expect(firstInvokeCall(invoke)[2]).toBe(toolContext);
  });

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
    expect(action).not.toHaveProperty("blocks");
    const message = preparedMessages(invoke)[0]!;
    expect(blockAt(message, 0).type).toBe("section");
    expect(blockAt(message, 1).type).toBe("section");
    const actionsBlock = blockAt(message, 2);
    expect(actionsBlock.type).toBe("actions");
    expect(elementAt(actionsBlock, 0).value).toBe("approve");
  });

  it("sends an exact mirrored portable control row once", async () => {
    const invoke = createInvokeSpy();
    const buttons = [{ label: "Approve", action: { type: "callback" as const, value: "approve" } }];

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "send",
        cfg: {},
        params: {
          to: "channel:C1",
          message: "Deploy?",
          presentation: { blocks: [{ type: "buttons", buttons }] },
          interactive: { blocks: [{ type: "buttons", buttons }] },
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(action).not.toHaveProperty("blocks");
    const message = preparedMessages(invoke)[0]!;
    const blocks = message.blocks as Array<Record<string, unknown>> | undefined;
    const actions = blocks?.filter((block) => block.type === "actions") ?? [];
    expect(actions).toHaveLength(1);
    expect(elementAt(actions[0]!, 0).value).toBe("approve");
  });

  it("sends native charts with a complete accessible text representation", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "send",
        cfg: {},
        params: {
          to: "channel:C1",
          message: "Revenue summary",
          presentation: {
            blocks: [
              {
                type: "chart",
                chartType: "pie",
                title: "Revenue mix",
                segments: [
                  { label: "Product", value: 60 },
                  { label: "Services", value: 40 },
                ],
              },
            ],
          },
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(action.content).toBe("Revenue summary");
    expect(action).not.toHaveProperty("blocks");
    expect(action).not.toHaveProperty("nativeDataFallbackBaseText");
    const message = preparedMessages(invoke)[0]!;
    expect(message.text).toBe(
      "Revenue summary\n\nRevenue mix (pie chart)\n- Product: 60\n- Services: 40",
    );
    expect(blockAt(message, 1)).toEqual({
      type: "data_visualization",
      title: "Revenue mix",
      chart: {
        type: "pie",
        segments: [
          { label: "Product", value: 60 },
          { label: "Services", value: 40 },
        ],
      },
    });
  });

  it("sends native tables with a complete accessible text representation", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "send",
        cfg: {},
        params: {
          to: "channel:C1",
          message: "Pipeline summary",
          presentation: {
            blocks: [
              {
                type: "table",
                caption: "Pipeline",
                headers: ["Account", "ARR"],
                rows: [
                  ["Acme", 125000],
                  ["Globex", 82000],
                ],
              },
            ],
          },
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(action.content).toBe("Pipeline summary");
    const message = preparedMessages(invoke)[0]!;
    expect(message.text).toBe(
      "Pipeline summary\n\nPipeline (table)\nAccount\tARR\nAcme\t125000\nGlobex\t82000",
    );
  });

  it.each([
    { name: "ASCII", message: `${"x".repeat(4_000)}TAIL` },
    { name: "multibyte", message: `${"😀".repeat(1_000)}TAIL` },
    { name: "expanded Slack markdown", message: `${"&".repeat(801)}TAIL` },
  ])("rejects oversized $name text-only edits before sending", async ({ message }) => {
    const invoke = createInvokeSpy();

    await expect(
      handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "edit",
          cfg: {},
          params: { channelId: "C1", messageId: "171234.567", message },
        } as never,
        invoke: invoke as never,
      }),
    ).rejects.toThrow("Slack edit exceeds the 4000-byte edit limit. Send a new message instead.");

    expect(invoke).not.toHaveBeenCalled();
  });

  it("accepts a text-only edit at Slack's exact byte limit", async () => {
    const invoke = createInvokeSpy();
    const message = "x".repeat(4_000);

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "edit",
        cfg: {},
        params: { channelId: "C1", messageId: "171234.567", message },
      } as never,
      invoke: invoke as never,
    });

    expect(firstAction(invoke)).toMatchObject({ action: "editMessage", content: message });
  });

  it("keeps oversized notification fallback for visibly rendered block edits", async () => {
    const invoke = createInvokeSpy();
    const message = "x".repeat(4_001);

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "edit",
        cfg: {},
        params: {
          channelId: "C1",
          messageId: "171234.567",
          message,
          presentation: { blocks: [{ type: "text", text: "Visible block content" }] },
        },
      } as never,
      invoke: invoke as never,
    });

    expect(firstAction(invoke)).toMatchObject({ action: "editMessage", content: message });
    expect(blockAt(firstAction(invoke), 0)).toMatchObject({ type: "section" });
  });

  it("edits native tables with a complete accessible text representation", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "edit",
        cfg: {},
        params: {
          channelId: "C1",
          messageId: "171234.567",
          message: "Updated pipeline",
          presentation: {
            blocks: [
              {
                type: "table",
                caption: "Pipeline",
                headers: ["Account", "Stage"],
                rows: [["Acme", "Won"]],
              },
            ],
          },
        },
      } as never,
      invoke: invoke as never,
    });

    expect(firstAction(invoke)).toMatchObject({
      action: "editMessage",
      channelId: "C1",
      messageId: "171234.567",
      content: "Updated pipeline\n\nPipeline (table)\n- Account: Acme; Stage: Won",
    });
  });

  it("routes non-native tables through Slack-safe text with native controls", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "send",
        cfg: {},
        params: {
          to: "channel:C1",
          message: "Summary",
          presentation: {
            blocks: [
              {
                type: "chart",
                chartType: "pie",
                title: "Revenue mix",
                segments: [{ label: "Product", value: 60 }],
              },
              ...largeTablePresentation().blocks,
              {
                type: "buttons",
                buttons: [{ label: "Stage", value: "stage" }],
              },
              {
                type: "select",
                placeholder: "Lane",
                options: [{ label: "Production", value: "production" }],
              },
            ],
          },
          interactive: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Refresh", value: "refresh" }],
              },
              {
                type: "select",
                placeholder: "Window",
                options: [{ label: "Recent", value: "recent" }],
              },
            ],
          },
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(action).not.toHaveProperty("separateTextAndBlocks");
    expect(action).not.toHaveProperty("blocks");
    const messages = preparedMessages(invoke);
    expect(messages).toHaveLength(3);
    expect(messages[0]?.text).toBe("Summary\n\nRevenue mix (pie chart)\n- Product: 60");
    expect(blockAt(messages[0]!, 1).type).toBe("data_visualization");
    expect(messages[1]?.text).toContain("- Account: <@U123>");
    expect(messages[1]?.text).toContain("- Account: account-99");
    expect(messages[1]?.textIsSlackPlainText).toBe(true);
    const controls = messages[2]!;
    const presentationButtons = blockAt(controls, 0);
    expect(presentationButtons.block_id).toBe("openclaw_reply_buttons_1");
    expect(elementAt(presentationButtons, 0)).toMatchObject({
      action_id: "openclaw:reply_button:1:1",
      value: "stage",
    });
    const presentationSelect = blockAt(controls, 1);
    expect(presentationSelect.block_id).toBe("openclaw_reply_select_1");
    expect(elementAt(presentationSelect, 0).action_id).toBe("openclaw:reply_select:1");
    const legacyButtons = blockAt(controls, 2);
    expect(legacyButtons.block_id).toBe("openclaw_reply_buttons_2");
    expect(elementAt(legacyButtons, 0)).toMatchObject({
      action_id: "openclaw:reply_button:2:1",
      value: "refresh",
    });
    const legacySelect = blockAt(controls, 3);
    expect(legacySelect.block_id).toBe("openclaw_reply_select_2");
    expect(elementAt(legacySelect, 0).action_id).toBe("openclaw:reply_select:2");
    expect(String(messages[1]?.text).length).toBeGreaterThan(8000);
  });

  it("keeps an oversized portable control label complete in literal fallback", async () => {
    const invoke = createInvokeSpy();
    const label = `Deploy ${"x".repeat(80)}`;

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "send",
        cfg: {},
        params: {
          to: "channel:C1",
          presentation: {
            blocks: [{ type: "buttons", buttons: [{ label, value: "deploy" }] }],
          },
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(action).not.toHaveProperty("blocks");
    expect(action).not.toHaveProperty("preparedMessages");
    expect(preparedMessages(invoke)).toEqual([{ text: `- ${label}`, textIsSlackPlainText: true }]);
  });

  it("uses text-only edits for non-native tables that fit one message", async () => {
    const invoke = createInvokeSpy();
    const headers = Array.from({ length: 21 }, (_entry, index) => `Column ${String(index)}`);

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "edit",
        cfg: {},
        params: {
          channelId: "C1",
          messageId: "171234.567",
          presentation: {
            blocks: [
              {
                type: "table",
                caption: "Wide pipeline",
                headers,
                rows: [headers.map((_header, index) => `Value ${String(index)}`)],
              },
            ],
          },
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(action.blocks).toBeUndefined();
    expect(action.content).toContain("Column 20: Value 20");
  });

  it("rejects non-native table edits whose complete fallback cannot fit", async () => {
    const invoke = createInvokeSpy();
    const headers = Array.from({ length: 21 }, (_entry, index) => `Column ${String(index)}`);
    const presentation = {
      blocks: [
        {
          type: "table" as const,
          caption: "Wide pipeline",
          headers,
          rows: Array.from({ length: 10 }, (_row, rowIndex) =>
            headers.map(
              (_header, columnIndex) => `Value ${String(rowIndex)}-${String(columnIndex)}`,
            ),
          ),
        },
      ],
    };
    const fallback = renderSlackMessagePresentationFallbackText({ presentation });
    expect(fallback.length).toBeGreaterThan(4000);
    expect(fallback.length).toBeLessThan(8000);

    await expect(
      handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "edit",
          cfg: {},
          params: {
            channelId: "C1",
            messageId: "171234.567",
            presentation,
          },
        } as never,
        invoke: invoke as never,
      }),
    ).rejects.toThrow("Slack presentation fallback exceeds the 4000-byte edit limit");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects non-native chart edits whose complete fallback cannot fit", async () => {
    const invoke = createInvokeSpy();
    const categories = Array.from(
      { length: 21 },
      (_entry, index) => `Category ${String(index)} ${"x".repeat(200)}`,
    );
    const presentation = {
      blocks: [
        {
          type: "chart" as const,
          chartType: "line" as const,
          title: "Long trend",
          categories,
          series: [{ name: "Series", values: categories.map((_category, index) => index) }],
        },
      ],
    };
    expect(renderSlackMessagePresentationFallbackText({ presentation }).length).toBeGreaterThan(
      4000,
    );

    await expect(
      handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "edit",
          cfg: {},
          params: { channelId: "C1", messageId: "171234.567", presentation },
        } as never,
        invoke: invoke as never,
      }),
    ).rejects.toThrow("Slack presentation fallback exceeds the 4000-byte edit limit");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps an unrenderable control label complete in text-only edits", async () => {
    const invoke = createInvokeSpy();
    const label = `Deploy ${"x".repeat(80)}`;

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "edit",
        cfg: {},
        params: {
          channelId: "C1",
          messageId: "171234.567",
          presentation: {
            blocks: [{ type: "buttons", buttons: [{ label, value: "deploy" }] }],
          },
        },
      } as never,
      invoke: invoke as never,
    });

    expect(firstAction(invoke)).toMatchObject({ content: `- ${label}`, blocks: undefined });
  });

  it("rejects presentation fallback edits that overflow after Slack markdown rendering", async () => {
    const invoke = createInvokeSpy();

    await expect(
      handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "edit",
          cfg: {},
          params: {
            channelId: "C1",
            messageId: "171234.567",
            presentation: {
              blocks: [{ type: "text", text: `${"&".repeat(801)}${"x".repeat(2_200)}` }],
            },
          },
        } as never,
        invoke: invoke as never,
      }),
    ).rejects.toThrow(
      "Slack presentation fallback exceeds the 4000-byte edit limit. Send a new message instead.",
    );

    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses complete text-only fallback when an edit exceeds fifty blocks", async () => {
    const invoke = createInvokeSpy();
    const presentation = {
      blocks: Array.from({ length: 51 }, (_entry, index) => ({
        type: "text" as const,
        text: `Detail ${String(index)}`,
      })),
    };

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "edit",
        cfg: {},
        params: { channelId: "C1", messageId: "171234.567", presentation },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(action.blocks).toBeUndefined();
    expect(action.content).toContain("Detail 0");
    expect(action.content).toContain("Detail 50");
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
    expect(action).not.toHaveProperty("blocks");
    const message = preparedMessages(invoke)[0]!;
    const firstButtons = blockAt(message, 1);
    expect(firstButtons.block_id).toBe("openclaw_reply_buttons_1");
    expect(elementAt(firstButtons, 0).action_id).toBe("openclaw:reply_button:1:1");
    const secondButtons = blockAt(message, 2);
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
    expect(action).not.toHaveProperty("blocks");
    const message = preparedMessages(invoke)[0]!;
    expect(blockAt(message, 0).type).toBe("section");
    const actionsBlock = blockAt(message, 1);
    expect(actionsBlock.type).toBe("actions");
    expect(elementAt(actionsBlock, 0).value).toBe("approve");
    expectForwardedCfg(invoke, cfg);
  });

  it.each([
    {
      name: "passes replyBroadcast through for Slack thread sends",
      params: {
        to: "channel:C1",
        message: "Visible from the channel",
        threadId: "111.222",
        replyBroadcast: true,
      },
      expected: {
        content: "Visible from the channel",
        threadTs: "111.222",
        replyBroadcast: true,
      },
    },
    {
      name: "passes topLevel through so same-channel Slack sends can suppress thread inheritance",
      params: {
        to: "channel:C1",
        message: "Visible in the parent channel",
        topLevel: true,
      },
      expected: { content: "Visible in the parent channel", threadTs: undefined, topLevel: true },
    },
    {
      name: "treats threadId null as a Slack top-level send request",
      params: {
        to: "channel:C1",
        message: "Visible in the parent channel",
        threadId: null,
      },
      expected: { content: "Visible in the parent channel", threadTs: undefined, topLevel: true },
    },
  ])("$name", async ({ params, expected }) => {
    const invoke = createInvokeSpy();
    const cfg = slackConfig();
    await handleSlackMessageAction({
      providerId: "slack",
      ctx: { action: "send", cfg, params } as never,
      invoke: invoke as never,
    });
    const action = firstAction(invoke);
    expect(action).toMatchObject({ action: "sendMessage", to: "channel:C1", ...expected });
    expect(action.threadTs).toBe(expected.threadTs);
    expectForwardedCfg(invoke, cfg);
    expectNoForwardedToolContext(invoke);
  });

  it.each([
    {
      name: "maps upload-file to the internal uploadFile action",
      params: {
        to: "user:U1",
        filePath: "/tmp/report.png",
        initialComment: "fresh build",
        filename: "build.png",
        title: "Build Screenshot",
        threadId: "111.222",
      },
      expected: {
        to: "user:U1",
        filePath: "/tmp/report.png",
        initialComment: "fresh build",
        filename: "build.png",
        title: "Build Screenshot",
        threadTs: "111.222",
      },
    },
    {
      name: "maps upload-file aliases to upload params",
      params: {
        channelId: "C1",
        media: "/tmp/chart.png",
        message: "chart attached",
        replyTo: "333.444",
      },
      expected: {
        to: "C1",
        filePath: "/tmp/chart.png",
        initialComment: "chart attached",
        threadTs: "333.444",
      },
    },
    {
      name: "maps upload-file path alias to filePath",
      params: {
        to: "channel:C1",
        path: "/tmp/report.txt",
        initialComment: "path alias",
      },
      expected: {
        to: "channel:C1",
        filePath: "/tmp/report.txt",
        initialComment: "path alias",
      },
    },
    {
      name: "maps an upload-file caption to the upload's initial comment",
      params: {
        channelId: "C1",
        media: "/tmp/chart.png",
        caption: "chart attached",
      },
      expected: {
        filePath: "/tmp/chart.png",
        initialComment: "chart attached",
      },
    },
    {
      name: "prefers an explicit upload-file initial comment over message and caption",
      params: {
        channelId: "C1",
        media: "/tmp/chart.png",
        initialComment: "",
        message: "message text",
        caption: "caption text",
      },
      expected: {
        filePath: "/tmp/chart.png",
        initialComment: "",
      },
    },
  ])("$name", async ({ params, expected }) => {
    const invoke = createInvokeSpy();
    const cfg = slackConfig();
    await handleSlackMessageAction({
      providerId: "slack",
      ctx: { action: "upload-file", cfg, params } as never,
      invoke: invoke as never,
    });
    expect(firstAction(invoke)).toMatchObject({ action: "uploadFile", ...expected });
    expectForwardedCfg(invoke, cfg);
    expectNoForwardedToolContext(invoke);
  });

  it.each(["forceDocument", "asDocument"] as const)(
    "normalizes %s for Slack send and upload-file",
    async (propertyName) => {
      const sendInvoke = createInvokeSpy();
      await handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "send",
          cfg: slackConfig(),
          params: {
            to: "channel:C1",
            media: "/tmp/original.png",
            [propertyName]: true,
          },
        } as never,
        invoke: sendInvoke as never,
      });
      expect(firstAction(sendInvoke)).toMatchObject({
        action: "sendMessage",
        forceDocument: true,
      });

      const uploadInvoke = createInvokeSpy();
      await handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "upload-file",
          cfg: slackConfig(),
          params: {
            to: "channel:C1",
            filePath: "/tmp/original.png",
            [propertyName]: true,
          },
        } as never,
        invoke: uploadInvoke as never,
      });
      expect(firstAction(uploadInvoke)).toMatchObject({
        action: "uploadFile",
        forceDocument: true,
      });
    },
  );

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

  it.each([2.5, "20"])(
    "forwards raw read limit %s to the authorized action owner",
    async (limit) => {
      const invoke = createInvokeSpy();

      await handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "read",
          cfg: {},
          params: { channelId: "C1", limit },
        } as never,
        invoke: invoke as never,
      });

      expect(firstAction(invoke)).toMatchObject({ action: "readMessages", limit });
      expect(invoke).toHaveBeenCalledOnce();
    },
  );

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

  it.each([
    {
      name: "maps download-file to the internal downloadFile action",
      params: { channelId: "C1", fileId: "F123", threadId: "111.222" },
      expected: { fileId: "F123", channelId: "C1", threadId: "111.222" },
    },
    {
      name: "maps download-file target aliases to scope fields",
      params: { to: "channel:C2", fileId: "F999", replyTo: "333.444" },
      expected: { fileId: "F999", channelId: "channel:C2", threadId: "333.444" },
    },
  ])("$name", async ({ params, expected }) => {
    const invoke = createInvokeSpy();
    const cfg = slackConfig();
    await handleSlackMessageAction({
      providerId: "slack",
      ctx: { action: "download-file", cfg, params } as never,
      invoke: invoke as never,
    });
    expect(firstAction(invoke)).toMatchObject({ action: "downloadFile", ...expected });
    expectForwardedCfg(invoke, cfg);
  });

  it("forwards tool context for current-channel download-file actions", async () => {
    const invoke = createInvokeSpy();
    const cfg = slackConfig();
    const toolContext = { currentChannelId: "C1" };

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "download-file",
        cfg,
        toolContext,
        params: {
          fileId: "F123",
        },
      } as never,
      invoke: invoke as never,
    });

    const action = firstAction(invoke);
    expect(action.action).toBe("downloadFile");
    expect(action.fileId).toBe("F123");
    expect(action.channelId).toBeUndefined();
    expectForwardedCfg(invoke, cfg);
    expect(firstInvokeCall(invoke)[2]).toBe(toolContext);
  });

  it.each([
    {
      name: "explains that download-file requires fileId, not messageId",
      params: { channelId: "C1", messageId: "1777423717.666499" },
      expectedError: /Did you mean to pass fileId/i,
    },
    {
      name: "explains that download-file requires fileId for message_id aliases",
      params: { channelId: "C1", message_id: "1777423717.666499" },
      expectedError: /Did you mean to pass fileId/i,
    },
    {
      name: "keeps the generic fileId requirement when no message id was supplied",
      params: { channelId: "C1" },
      expectedError: /fileId/i,
    },
  ])("$name", async ({ params, expectedError }) => {
    await expect(
      handleSlackMessageAction({
        providerId: "slack",
        ctx: { action: "download-file", cfg: {}, params } as never,
        invoke: createInvokeSpy() as never,
      }),
    ).rejects.toThrow(expectedError);
  });

  it("defaults member-info userId to the inbound sender when omitted", async () => {
    const invoke = createInvokeSpy();
    const toolContext = { currentChannelProvider: " Slack " };

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "member-info",
        cfg: {},
        params: {},
        accountId: "OPS",
        requesterAccountId: "ops",
        requesterSenderId: "U123",
        toolContext,
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ action: "memberInfo", userId: "U123" }),
      expect.any(Object),
      toolContext,
    );
  });

  it("defaults member-info userId through the configured default Slack account", async () => {
    const invoke = createInvokeSpy();
    const toolContext = { currentChannelProvider: "slack" };

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "member-info",
        cfg: { channels: { slack: { defaultAccount: "ops", accounts: { ops: {} } } } },
        params: {},
        requesterAccountId: "OPS",
        requesterSenderId: "U123",
        toolContext,
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ action: "memberInfo", userId: "U123" }),
      expect.any(Object),
      toolContext,
    );
  });

  it.each([
    ["has no inbound sender", { toolContext: { currentChannelProvider: "slack" } }],
    ["has no source provider", { requesterSenderId: "U123" }],
    [
      "has no source account",
      {
        accountId: "default",
        requesterSenderId: "U123",
        toolContext: { currentChannelProvider: "slack" },
      },
    ],
    [
      "targets another Slack account",
      {
        accountId: "other",
        requesterAccountId: "default",
        requesterSenderId: "U123",
        toolContext: { currentChannelProvider: "slack" },
      },
    ],
    [
      "comes from another provider",
      { requesterSenderId: "U123", toolContext: { currentChannelProvider: "telegram" } },
    ],
  ])("rejects member-info without userId when the request %s", async (_label, context) => {
    await expect(
      handleSlackMessageAction({
        providerId: "slack",
        ctx: { action: "member-info", cfg: {}, params: {}, ...context } as never,
        invoke: createInvokeSpy() as never,
      }),
    ).rejects.toThrow(/member-info requires a userId/i);
  });

  it("prefers an explicit member-info userId over the inbound sender", async () => {
    const invoke = createInvokeSpy();
    const toolContext = { currentChannelProvider: "telegram" };

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "member-info",
        cfg: {},
        params: { userId: "U999" },
        accountId: "other",
        requesterAccountId: "default",
        requesterSenderId: "U123",
        toolContext,
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ action: "memberInfo", userId: "U999" }),
      expect.any(Object),
      toolContext,
    );
  });
});

describe("extractSlackToolSend", () => {
  it("maps native thread and top-level fields into send telemetry", () => {
    expect(
      extractSlackToolSend({
        action: "sendMessage",
        to: "channel:C1",
        threadTs: "171.222",
      }),
    ).toMatchObject({
      to: "channel:C1",
      threadId: "171.222",
    });
    expect(
      extractSlackToolSend({
        action: "sendMessage",
        to: "channel:C1",
      }),
    ).toMatchObject({
      to: "channel:C1",
      threadImplicit: true,
    });
    expect(
      extractSlackToolSend({
        action: "uploadFile",
        to: "channel:C1",
      }),
    ).toMatchObject({
      to: "channel:C1",
      threadImplicit: true,
    });
    expect(
      extractSlackToolSend({
        action: "sendMessage",
        to: "channel:C1",
        threadTs: null,
      }),
    ).toMatchObject({
      to: "channel:C1",
      threadSuppressed: true,
    });
  });

  it("maps generic send and upload thread precedence into telemetry", () => {
    expect(
      extractSlackToolSend({
        action: "send",
        to: "channel:C1",
        threadId: "111.000",
        replyTo: "999.000",
      }),
    ).toMatchObject({
      to: "channel:C1",
      threadId: "999.000",
    });
    expect(
      extractSlackToolSend({
        action: "upload-file",
        to: "channel:C1",
        threadId: "111.000",
        replyTo: "999.000",
      }),
    ).toMatchObject({
      to: "channel:C1",
      threadId: "111.000",
    });
    expect(
      extractSlackToolSend({
        action: "upload-file",
        to: "channel:C1",
        replyTo: "999.000",
      }),
    ).toMatchObject({
      to: "channel:C1",
      threadId: "999.000",
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
