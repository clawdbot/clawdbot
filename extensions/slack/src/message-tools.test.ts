import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { listSlackMessageActions } from "./message-actions.js";
import { describeSlackMessageTool } from "./message-tool-api.js";

describe("Slack message tools", () => {
  it("describes configured Slack message actions without loading channel runtime", () => {
    expect(
      describeSlackMessageTool({
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
            },
          },
        },
      }),
    ).toMatchObject({
      actions: expect.arrayContaining(["send", "upload-file", "read"]),
      capabilities: expect.arrayContaining(["presentation"]),
    });
  });

  it("honors account-scoped action gates", () => {
    expect(
      describeSlackMessageTool({
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-default",
              accounts: {
                ops: {
                  botToken: "xoxb-ops",
                  actions: {
                    messages: false,
                  },
                },
              },
            },
          },
        },
        accountId: "ops",
      }).actions,
    ).not.toContain("upload-file");
  });

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
