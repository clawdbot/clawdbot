import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { listSlackMessageActions } from "./message-actions.js";
import { describeSlackMessageTool } from "./message-tool-api.js";

function requireSchemaProperty(
  discovery: ReturnType<typeof describeSlackMessageTool>,
  property: string,
) {
  const schemas = Array.isArray(discovery.schema)
    ? discovery.schema
    : discovery.schema
      ? [discovery.schema]
      : [];
  const schema = schemas.find((entry) => property in entry.properties);
  if (!schema) {
    throw new Error(`Missing schema property ${property}`);
  }
  return {
    schema,
    property: schema.properties[property] as { description?: string },
  };
}

describe("Slack message tools", () => {
  it("describes configured Slack message actions without loading channel runtime", () => {
    const discovery = describeSlackMessageTool({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
          },
        },
      },
    });

    expect(Object.keys(discovery).toSorted()).toEqual(["actions", "capabilities", "schema"]);
    expect(discovery.actions).toEqual([
      "send",
      "react",
      "reactions",
      "read",
      "edit",
      "delete",
      "download-file",
      "upload-file",
      "pin",
      "unpin",
      "list-pins",
      "member-info",
      "emoji-list",
    ]);
    expect(discovery.capabilities).toEqual(["presentation"]);
    expect(Array.isArray(discovery.schema)).toBe(true);
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

    expect(listSlackMessageActions(cfg)).toEqual([
      "send",
      "react",
      "reactions",
      "read",
      "edit",
      "delete",
      "download-file",
      "upload-file",
      "pin",
      "unpin",
      "list-pins",
      "member-info",
      "emoji-list",
    ]);
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

  it("describes Slack file ids separately from message ids", () => {
    const discovery = describeSlackMessageTool({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
          },
        },
      },
    });

    const { schema, property } = requireSchemaProperty(discovery, "fileId");

    expect(schema.actions).toEqual(["download-file"]);
    expect(property.description).toMatch(/Slack file id/i);
    expect(property.description).toContain("F0B0LTT8M36");
    expect(property.description).toContain("event.files[].id");
    expect(property.description).toMatch(/not the Slack message timestamp\/messageId/i);
  });

  it("describes current Slack message id actions without stale aliases", () => {
    const discovery = describeSlackMessageTool({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
          },
        },
      },
    });

    const { schema, property } = requireSchemaProperty(discovery, "messageId");
    const alias = schema.properties.message_id as { description?: string };

    expect(schema.actions).toEqual(["react", "reactions", "edit", "delete", "pin", "unpin"]);
    expect(schema.actions).not.toContain("unsend");
    expect(property.description).toContain("1777423717.666499");
    expect(property.description).toMatch(/Not used by download-file/i);
    expect(alias.description).toMatch(/Alias for messageId/i);
  });

  it("describes Slack reply broadcasts as send-only thread hints", () => {
    const discovery = describeSlackMessageTool({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
          },
        },
      },
    });

    const { schema, property } = requireSchemaProperty(discovery, "replyBroadcast");

    expect(schema.actions).toEqual(["send"]);
    expect(property.description).toContain('action="send"');
    expect(property.description).toContain("threadId");
    expect(property.description).toContain("Not supported for media or upload-file");
  });

  it("describes Slack top-level sends as a same-channel thread opt-out", () => {
    const discovery = describeSlackMessageTool({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
          },
        },
      },
    });

    const { schema, property } = requireSchemaProperty(discovery, "topLevel");

    expect(schema.actions).toEqual(["send"]);
    expect(property.description).toContain('action="send"');
    expect(property.description).toContain("parent-channel");
    expect(property.description).toContain("threadId: null");
  });

  it("omits Slack file and message id schemas when those actions are disabled", () => {
    const discovery = describeSlackMessageTool({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
            actions: {
              reactions: false,
              messages: false,
              pins: false,
              memberInfo: false,
              emojiList: false,
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(discovery.actions).toEqual(["send"]);
    const schemas = Array.isArray(discovery.schema)
      ? discovery.schema
      : discovery.schema
        ? [discovery.schema]
        : [];
    const propertyNames = schemas.flatMap((entry) => Object.keys(entry.properties));
    expect(propertyNames).not.toContain("fileId");
    expect(propertyNames).not.toContain("messageId");
    expect(propertyNames).toContain("replyBroadcast");
  });
});
