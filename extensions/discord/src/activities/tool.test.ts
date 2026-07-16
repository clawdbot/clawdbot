import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { buildDiscordActivityCustomId } from "../component-custom-id.js";
import type { sendMessageDiscord } from "../send.js";
import { createActivityTestRuntime } from "./test-helpers.test-support.js";
import { createDiscordWidgetTool } from "./tool.js";

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

  it("stores a wrapped widget and posts its launch button", async () => {
    const runtime = createActivityTestRuntime();
    const send = vi.fn(async (..._args: Parameters<typeof sendMessageDiscord>) => ({
      messageId: "message-1",
      channelId: "987654321",
      receipt: {},
    }));
    const tool = createDiscordWidgetTool(discordContext(), {
      runtime,
      sendMessage: send as unknown as typeof sendMessageDiscord,
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
    const options = send.mock.calls[0]?.[2] as { components?: Array<{ serialize(): unknown }> };
    expect(send).toHaveBeenCalledWith("channel:987654321", "Status", expect.any(Object));
    expect(options.components?.[0]?.serialize()).toEqual({
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          custom_id: buildDiscordActivityCustomId(details.widgetId),
          label: "Open widget",
        },
      ],
    });
  });

  it("keeps full documents unchanged and rejects oversized HTML", async () => {
    const document = "<!doctype html><html><body>full</body></html>";
    const runtime = createActivityTestRuntime();
    const send = vi.fn(async (..._args: Parameters<typeof sendMessageDiscord>) => ({
      messageId: "message-1",
      channelId: "987654321",
      receipt: {},
    }));
    const tool = createDiscordWidgetTool(discordContext(), {
      runtime,
      sendMessage: send as unknown as typeof sendMessageDiscord,
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
    }) as unknown as typeof sendMessageDiscord;
    const tool = createDiscordWidgetTool(discordContext(), { runtime, sendMessage: send });
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

  it("requires a concrete channel target", async () => {
    const tool = createDiscordWidgetTool(discordContext({ nativeChannelId: undefined }), {
      runtime: createActivityTestRuntime(),
      sendMessage: vi.fn() as unknown as typeof sendMessageDiscord,
    });
    if (!tool) {
      throw new Error("expected Discord widget tool");
    }
    await expect(
      tool.execute("missing-channel", { html: "hello", title: "No channel" }),
    ).rejects.toThrow("requires a concrete Discord channel");
  });
});
