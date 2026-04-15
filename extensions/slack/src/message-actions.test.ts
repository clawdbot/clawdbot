import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { listSlackMessageActions } from "./message-actions.js";

describe("listSlackMessageActions", () => {
  it("includes file actions when message actions are enabled", () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          actions: {
            messages: true,
          },
        },
      },
    } as OpenClawConfig;

    expect(listSlackMessageActions(cfg)).toEqual(
      expect.arrayContaining(["read", "edit", "delete", "download-file", "upload-file"]),
    );
  });

  it("honors the selected Slack account during discovery", () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-root",
          actions: {
            reactions: false,
            messages: false,
            pins: false,
            memberInfo: false,
            emojiList: false,
          },
          accounts: {
            default: {
              botToken: "xoxb-default",
              actions: {
                reactions: false,
                messages: false,
                pins: false,
                memberInfo: false,
                emojiList: false,
              },
            },
            work: {
              botToken: "xoxb-work",
              actions: {
                reactions: true,
                messages: true,
                pins: false,
                memberInfo: false,
                emojiList: false,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(listSlackMessageActions(cfg, "default")).toEqual(["send"]);
    expect(listSlackMessageActions(cfg, "work")).toEqual([
      "send",
      "react",
      "reactions",
      "read",
      "edit",
      "delete",
      "download-file",
      "upload-file",
    ]);
  });
});
