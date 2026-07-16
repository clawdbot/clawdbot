import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import {
  buildDiscordActivityCustomId,
  parseDiscordActivityCustomIdForInteraction,
} from "../component-custom-id.js";
import { buildDiscordComponentMessage } from "../components.js";
import type { sendDiscordComponentMessage } from "../send.components.js";
import { createDiscordSendReceipt } from "../send.receipt.js";
import { createActivityTestRuntime } from "./test-helpers.test-support.js";
import { createDiscordShowWidgetTool, createDiscordWidgetTool } from "./tool.js";

function discordContext(overrides: Partial<OpenClawPluginToolContext> = {}) {
  return {
    messageChannel: "discord",
    nativeChannelId: "987654321",
    agentAccountId: "default",
    ...overrides,
  } satisfies OpenClawPluginToolContext;
}

describe("discord_widget", () => {
  it("is absent outside Discord sessions", () => {
    expect(
      createDiscordWidgetTool(discordContext({ messageChannel: "slack" }), {
        runtime: createActivityTestRuntime(),
      }),
    ).toBeNull();
  });

  it("marks the legacy name deprecated", () => {
    const tool = createDiscordWidgetTool(discordContext(), {
      runtime: createActivityTestRuntime(),
    });
    if (!tool) {
      throw new Error("expected deprecated Discord widget tool");
    }

    expect(tool.description).toMatch(/^Deprecated: use show_widget\./);
    expect((tool.parameters as { properties?: Record<string, unknown> }).properties).toHaveProperty(
      "html",
    );
  });

  it("stores a wrapped widget and posts its launch button", async () => {
    const runtime = createActivityTestRuntime();
    const send = vi.fn(async (..._args: Parameters<typeof sendDiscordComponentMessage>) => ({
      messageId: "message-1",
      channelId: "987654321",
      receipt: {},
    }));
    const tool = createDiscordWidgetTool(discordContext(), {
      runtime,
      sendComponentMessage: send as unknown as typeof sendDiscordComponentMessage,
      now: () => 7,
    });
    if (!tool) {
      throw new Error("expected Discord widget tool");
    }

    const result = await tool.execute("widget-call", {
      html: "<button onclick=\"document.body.dataset.clicked='yes'\">Click</button>",
      title: "Status",
    });
    const details = result.details as { widgetId: string; messageId: string };
    const stored = await runtime.store.lookupWidget(details.widgetId);

    expect(details.messageId).toBe("message-1");
    expect(details.widgetId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(stored).toMatchObject({
      title: "Status",
      channelId: "987654321",
      accountId: "default",
      createdAt: 7,
    });
    expect(stored?.html).toContain("<!doctype html>");
    expect(stored?.html).toContain("<button");
    const spec = send.mock.calls[0]?.[1];
    const customId = buildDiscordActivityCustomId(details.widgetId);
    expect(send).toHaveBeenCalledWith("channel:987654321", expect.any(Object), expect.any(Object));
    expect(send.mock.calls[0]?.[2]).toMatchObject({ allowedMentions: { parse: [] } });
    if (!spec) {
      throw new Error("expected Discord component spec");
    }
    expect(spec).toEqual({
      text: "Status",
      blocks: [
        {
          type: "actions",
          buttons: [
            {
              label: "Open widget",
              style: "secondary",
              internalCustomId: customId,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(buildDiscordComponentMessage({ spec }).components)).toContain(customId);
    expect(parseDiscordActivityCustomIdForInteraction(customId)).toEqual({
      key: "ocactivity",
      data: { widgetId: details.widgetId },
    });
  });

  it("resolves a provider-prefixed forum thread target", async () => {
    const runtime = createActivityTestRuntime();
    const send = vi.fn(async (..._args: Parameters<typeof sendDiscordComponentMessage>) => ({
      messageId: "message-1",
      channelId: "987654321",
      receipt: {},
    }));
    const tool = createDiscordWidgetTool(
      discordContext({
        nativeChannelId: undefined,
        deliveryContext: { channel: "discord", to: "discord:channel:987654321" },
      }),
      {
        runtime,
        sendComponentMessage: send as unknown as typeof sendDiscordComponentMessage,
      },
    );
    if (!tool) {
      throw new Error("expected Discord widget tool");
    }

    const result = await tool.execute("forum-widget", {
      html: "<p>Forum widget</p>",
      title: "Forum widget",
    });

    expect(result.details).toMatchObject({ channelId: "987654321" });
    expect(send).toHaveBeenCalledWith(
      "channel:987654321",
      expect.objectContaining({ text: "Forum widget" }),
      expect.any(Object),
    );
  });

  it("keeps full documents unchanged and rejects oversized HTML", async () => {
    const document = "<!doctype html><html><body>full</body></html>";
    const runtime = createActivityTestRuntime();
    const send = vi.fn(async (..._args: Parameters<typeof sendDiscordComponentMessage>) => ({
      messageId: "message-1",
      channelId: "987654321",
      receipt: {},
    }));
    const tool = createDiscordWidgetTool(discordContext(), {
      runtime,
      sendComponentMessage: send as unknown as typeof sendDiscordComponentMessage,
    });
    if (!tool) {
      throw new Error("expected Discord widget tool");
    }
    const result = await tool.execute("full-document", { html: document, title: "Full" });
    const details = result.details as { widgetId: string };
    await expect(runtime.store.lookupWidget(details.widgetId)).resolves.toMatchObject({
      html: document,
    });

    // 49152 bytes is the 48 KiB cap mirrored from tool.ts.
    await expect(
      tool.execute("oversized", {
        html: "x".repeat(49_153),
        title: "Too large",
      }),
    ).rejects.toThrow("html exceeds maximum size (49152 bytes)");
  });

  it("leaves the widget store unchanged when posting the launch button fails", async () => {
    const runtime = createActivityTestRuntime();
    const existingId = await runtime.store.createWidget({
      html: "<p>existing</p>",
      title: "Existing",
      channelId: "987654321",
      accountId: "default",
      createdAt: 1,
    });
    const failure = new Error("send failed");
    const send = vi.fn(async () => {
      throw failure;
    }) as unknown as typeof sendDiscordComponentMessage;
    const tool = createDiscordWidgetTool(discordContext(), { runtime, sendComponentMessage: send });
    if (!tool) {
      throw new Error("expected Discord widget tool");
    }

    await expect(
      tool.execute("failed-send", { html: "<p>temporary</p>", title: "Temporary" }),
    ).rejects.toBe(failure);
    await expect(
      runtime.store.singleWidgetForChannel("default", "987654321"),
    ).resolves.toMatchObject({ id: existingId, widget: { title: "Existing" } });
  });

  it("keeps a widget when component bookkeeping fails after delivery", async () => {
    const runtime = createActivityTestRuntime();
    const failure = new Error("registry failed");
    const send = vi.fn(async (...args: Parameters<typeof sendDiscordComponentMessage>) => {
      await args[2].onDeliveryResult?.({
        messageId: "delivered-message",
        channelId: "987654321",
        receipt: createDiscordSendReceipt({
          platformMessageIds: ["delivered-message"],
          channelId: "987654321",
          kind: "text",
        }),
      });
      throw failure;
    }) as unknown as typeof sendDiscordComponentMessage;
    const tool = createDiscordWidgetTool(discordContext(), { runtime, sendComponentMessage: send });
    if (!tool) {
      throw new Error("expected Discord widget tool");
    }

    const result = await tool.execute("delivered-send", {
      html: "<p>delivered</p>",
      title: "Delivered",
    });
    const details = result.details as { widgetId: string; messageId: string };

    expect(details.messageId).toBe("delivered-message");
    await expect(runtime.store.lookupWidget(details.widgetId)).resolves.toMatchObject({
      title: "Delivered",
    });
  });

  it("requires a concrete channel target", async () => {
    const tool = createDiscordWidgetTool(discordContext({ nativeChannelId: undefined }), {
      runtime: createActivityTestRuntime(),
      sendComponentMessage: vi.fn() as unknown as typeof sendDiscordComponentMessage,
    });
    if (!tool) {
      throw new Error("expected Discord widget tool");
    }
    await expect(
      tool.execute("missing-channel", { html: "hello", title: "No channel" }),
    ).rejects.toThrow("requires a concrete Discord channel");
  });

  it("rejects direct-message targets without a channel", async () => {
    const tool = createDiscordWidgetTool(
      discordContext({
        nativeChannelId: undefined,
        deliveryContext: { channel: "discord", to: "discord:user:987654321" },
      }),
      {
        runtime: createActivityTestRuntime(),
        sendComponentMessage: vi.fn() as unknown as typeof sendDiscordComponentMessage,
      },
    );
    if (!tool) {
      throw new Error("expected Discord widget tool");
    }
    await expect(tool.execute("dm-target", { html: "hello", title: "No channel" })).rejects.toThrow(
      "requires a concrete Discord channel",
    );
  });
});

describe("show_widget", () => {
  it("maps widget_code to the Discord Activity document", async () => {
    const runtime = createActivityTestRuntime();
    const send = vi.fn(async (..._args: Parameters<typeof sendDiscordComponentMessage>) => ({
      messageId: "message-1",
      channelId: "987654321",
      receipt: {},
    }));
    const tool = createDiscordShowWidgetTool(discordContext(), {
      runtime,
      sendComponentMessage: send as unknown as typeof sendDiscordComponentMessage,
    });
    if (!tool) {
      throw new Error("expected unified Discord widget tool");
    }

    expect(tool.name).toBe("show_widget");
    expect(tool.description).toMatch(/^Show an interactive, self-contained HTML widget/);
    expect((tool.parameters as { properties?: Record<string, unknown> }).properties).toMatchObject({
      title: expect.any(Object),
      widget_code: expect.any(Object),
      button_label: expect.any(Object),
    });
    expect(
      (tool.parameters as { properties?: Record<string, unknown> }).properties,
    ).not.toHaveProperty("html");

    const result = await tool.execute("unified-widget", {
      title: "Unified",
      widget_code: "<p>Discord surface</p>",
      button_label: "Launch",
    });
    const details = result.details as { widgetId: string };

    await expect(runtime.store.lookupWidget(details.widgetId)).resolves.toMatchObject({
      title: "Unified",
      html: expect.stringContaining("<p>Discord surface</p>"),
    });
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      blocks: [{ buttons: [{ label: "Launch" }] }],
    });
  });
});
