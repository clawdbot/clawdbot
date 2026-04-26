import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("ACP binding cutover schema", () => {
  it("accepts top-level typed ACP bindings with per-agent runtime defaults", () => {
    const parsed = OpenClawSchema.safeParse({
      agents: {
        list: [
          { id: "main", default: true, runtime: { type: "embedded" } },
          {
            id: "coding",
            runtime: {
              type: "acp",
              acp: {
                agent: "codex",
                backend: "acpx",
                mode: "persistent",
                cwd: "/workspace/openclaw",
              },
            },
          },
        ],
      },
      bindings: [
        {
          type: "route",
          agentId: "main",
          match: { channel: "chat-a", accountId: "default" },
        },
        {
          type: "acp",
          agentId: "coding",
          match: {
            channel: "chat-a",
            accountId: "default",
            peer: { kind: "channel", id: "1478836151241412759" },
          },
          acp: {
            label: "codex-main",
            backend: "acpx",
          },
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts route binding session dmScope overrides", () => {
    const parsed = OpenClawSchema.safeParse({
      bindings: [
        {
          type: "route",
          agentId: "main",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "direct", id: "1497598990336790559" },
          },
          session: {
            dmScope: "per-account-channel-peer",
          },
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects legacy Discord channel-local ACP binding fields", () => {
    const parsed = OpenClawSchema.safeParse({
      channels: {
        discord: {
          guilds: {
            "1459246755253325866": {
              channels: {
                "1478836151241412759": {
                  bindings: {
                    acp: {
                      agentId: "codex",
                      mode: "persistent",
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects legacy Telegram topic-local ACP binding fields", () => {
    const parsed = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              topics: {
                "42": {
                  bindings: {
                    acp: {
                      agentId: "codex",
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects ACP bindings without a peer conversation target", () => {
    const parsed = OpenClawSchema.safeParse({
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: { channel: "chat-a", accountId: "default" },
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts ACP bindings for arbitrary channel ids when the peer target is explicit", () => {
    const parsed = OpenClawSchema.safeParse({
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "plugin-chat",
            accountId: "default",
            peer: { kind: "channel", id: "C123456" },
          },
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts ACP bindings for generic direct and group peer kinds", () => {
    const parsed = OpenClawSchema.safeParse({
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "plugin-chat",
            accountId: "default",
            peer: { kind: "direct", id: "peer-42" },
          },
        },
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "plugin-chat",
            accountId: "default",
            peer: { kind: "group", id: "group-42" },
          },
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts deprecated dm peer kind for backward compatibility", () => {
    const parsed = OpenClawSchema.safeParse({
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "plugin-chat",
            accountId: "default",
            peer: { kind: "dm", id: "legacy-peer" },
          },
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });
});
