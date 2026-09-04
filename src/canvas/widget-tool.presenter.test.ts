import { access } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { WidgetPresenter } from "../plugins/plugin-registration.types.js";
import { resolveCanvasDocumentsDir } from "./documents.js";
import { createShowWidgetTool } from "./widget-tool.js";
import { buildWidgetDocument } from "./wrap.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("show_widget current-channel presentation", () => {
  it("presents once without materializing an inline view", async () => {
    const stateDir = tempDirs.make("openclaw-widget-presenter-");
    const present = vi.fn(async () => ({
      ok: true as const,
      value: {
        kind: "message" as const,
        receipt: {
          primaryPlatformMessageId: "message-1",
          platformMessageIds: ["message-1"],
          parts: [],
          sentAt: 1,
        },
      },
    }));
    const context = {
      messageChannel: "discord",
      accountId: "work",
      nativeChannelId: "channel-1",
      currentChannelId: "channel:channel-1",
      currentMessagingTarget: "discord:channel:channel-1",
      sessionKey: "agent:main:discord",
    };
    const presenter: WidgetPresenter = {
      target: "current_channel",
      description: "Post in the current channel",
      capabilities: { sourceKinds: ["html"], maxSourceBytes: 48 * 1024 },
      match: (candidate) => candidate.messageChannel === "discord",
      availability: async () => ({ ok: true, value: { available: true } }),
      present,
    };
    const tool = createShowWidgetTool({
      stateDir,
      sessionId: "current-channel",
      inlineClientAvailable: false,
      presenters: [presenter],
      presenterContext: context,
    });

    expect(tool.requiredClientCaps).toBeUndefined();
    expect(
      (tool.parameters as { properties?: { kind?: { enum?: string[] } } }).properties?.kind?.enum,
    ).toEqual(["html"]);
    const result = await tool.execute("current-channel", {
      title: "Status",
      widget_code: "<p>ready</p>",
    });
    const parsed = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "null");

    expect(parsed).toMatchObject({
      kind: "widget",
      presentation: {
        target: "current_channel",
        title: "Status",
        receipt: { primaryPlatformMessageId: "message-1" },
      },
      text: "Widget presented in the current channel as message message-1",
    });
    expect(present).toHaveBeenCalledExactlyOnceWith({
      document: { kind: "html", html: buildWidgetDocument("Status", "<p>ready</p>") },
      title: "Status",
      context,
    });
    await expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow();
  });
});
