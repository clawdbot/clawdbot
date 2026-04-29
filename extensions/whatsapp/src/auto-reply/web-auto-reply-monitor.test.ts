import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMentionConfig } from "./mentions.js";
import { applyGroupGating, type GroupHistoryEntry } from "./monitor/group-gating.js";
import { buildInboundLine, formatReplyContext } from "./monitor/message-line.js";
import type { WebInboundMsg } from "./types.js";

let sessionDir: string | undefined;
let sessionStorePath: string;

beforeEach(async () => {
  sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-group-gating-"));
  sessionStorePath = path.join(sessionDir, "sessions.json");
  await fs.writeFile(sessionStorePath, "{}");
});

afterEach(async () => {
  if (sessionDir) {
    await fs.rm(sessionDir, { recursive: true, force: true });
    sessionDir = undefined;
  }
});

const makeConfig = (overrides: Record<string, unknown>) =>
  ({
    channels: {
      whatsapp: {
        groupPolicy: "open",
        groups: { "*": { requireMention: true } },
      },
    },
    session: { store: sessionStorePath },
    ...overrides,
  }) as unknown as import("openclaw/plugin-sdk/config-types").OpenClawConfig;

async function runGroupGating(params: {
  cfg: import("openclaw/plugin-sdk/config-types").OpenClawConfig;
  msg: WebInboundMsg;
  conversationId?: string;
  agentId?: string;
  selfChatMode?: boolean;
  authDir?: string;
}) {
  const groupHistories = new Map<string, GroupHistoryEntry[]>();
  const conversationId = params.conversationId ?? "123@g.us";
  const agentId = params.agentId ?? "main";
  const sessionKey = `agent:${agentId}:whatsapp:group:${conversationId}`;
  const baseMentionConfig = buildMentionConfig(params.cfg, undefined);
  const result = await applyGroupGating({
    cfg: params.cfg,
    msg: params.msg,
    conversationId,
    groupHistoryKey: `whatsapp:default:group:${conversationId}`,
    agentId,
    sessionKey,
    baseMentionConfig,
    authDir: params.authDir,
    selfChatMode: params.selfChatMode,
    groupHistories,
    groupHistoryLimit: 10,
    groupMemberNames: new Map(),
    logVerbose: () => {},
    replyLogger: { debug: () => {} },
  });
  return { result, groupHistories };
}

function createGroupMessage(overrides: Partial<WebInboundMsg> = {}): WebInboundMsg {
  return {
    id: "g1",
    from: "123@g.us",
    conversationId: "123@g.us",
    chatId: "123@g.us",
    chatType: "group",
    to: "+2",
    accountId: "default",
    body: "hello group",
    senderE164: "+111",
    senderName: "Alice",
    selfE164: "+999",
    sendComposing: async () => {},
    reply: async (_text, _options) => {},
    sendMedia: async (_payload, _options) => {},
    ...overrides,
  };
}

function makeOwnerGroupConfig() {
  return makeConfig({
    channels: {
      whatsapp: {
        allowFrom: ["+111"],
        groups: { "*": { requireMention: true } },
      },
    },
  });
}

function makeInboundCfg(messagePrefix = "") {
  return {
    agents: { defaults: { workspace: "/tmp/openclaw" } },
    channels: { whatsapp: { messagePrefix } },
  } as never;
}

describe("applyGroupGating", () => {
  it("treats reply-to-bot as implicit mention", async () => {
    const cfg = makeConfig({});
    const { result } = await runGroupGating({
      cfg,
      msg: createGroupMessage({
        id: "m1",
        to: "+15550000",
        accountId: "default",
        body: "following up",
        timestamp: Date.now(),
        selfJid: "15551234567@s.whatsapp.net",
        selfE164: "+15551234567",
        replyToId: "m0",
        replyToBody: "bot said hi",
        replyToSender: "+15551234567",
        replyToSenderJid: "15551234567@s.whatsapp.net",
        replyToSenderE164: "+15551234567",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("does not treat self-number quoted replies as implicit mention in selfChatMode groups", async () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          selfChatMode: true,
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });
    const { result } = await runGroupGating({
      cfg,
      selfChatMode: true,
      msg: createGroupMessage({
        id: "m-self-reply",
        to: "+15550000",
        accountId: "default",
        body: "following up on my own message",
        timestamp: Date.now(),
        senderE164: "+15551234567",
        senderJid: "15551234567@s.whatsapp.net",
        selfJid: "15551234567@s.whatsapp.net",
        selfE164: "+15551234567",
        replyToId: "m0",
        replyToBody: "my earlier message",
        replyToSender: "+15551234567",
        replyToSenderJid: "15551234567@s.whatsapp.net",
        replyToSenderE164: "+15551234567",
      }),
    });

    expect(result.shouldProcess).toBe(false);
  });

  it("still treats reply-to-bot as implicit mention in selfChatMode when sender is a different user", async () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          selfChatMode: true,
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });
    const { result } = await runGroupGating({
      cfg,
      selfChatMode: true,
      msg: createGroupMessage({
        id: "m-other-reply",
        to: "+15550000",
        accountId: "default",
        body: "following up on bot reply",
        timestamp: Date.now(),
        senderE164: "+15559999999",
        senderJid: "15559999999@s.whatsapp.net",
        selfJid: "15551234567@s.whatsapp.net",
        selfE164: "+15551234567",
        replyToId: "m0",
        replyToBody: "bot earlier response",
        replyToSender: "+15551234567",
        replyToSenderJid: "15551234567@s.whatsapp.net",
        replyToSenderE164: "+15551234567",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("processes explicit group @mentions when self is in allowFrom (#49317)", async () => {
    if (!sessionDir) {
      throw new Error("sessionDir not initialized");
    }
    await fs.writeFile(
      path.join(sessionDir, "lid-mapping-216372600647751_reverse.json"),
      JSON.stringify("+15551234567"),
    );
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          allowFrom: ["+15551234567"],
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });
    const msg = createGroupMessage({
      id: "g-self-lid-mention",
      accountId: "default",
      body: "@216372600647751 can you see this?",
      mentionedJids: ["216372600647751@lid"],
      senderE164: "+15550001111",
      senderName: "Alice",
      selfE164: "+15551234567",
      selfJid: "15551234567@s.whatsapp.net",
    });

    const { result, groupHistories } = await runGroupGating({
      cfg,
      authDir: sessionDir,
      msg,
    });

    expect(result.shouldProcess).toBe(true);
    expect(msg.wasMentioned).toBe(true);
    expect(groupHistories.get("whatsapp:default:group:123@g.us")).toBeUndefined();
  });

  it("honors per-account selfChatMode overrides before suppressing implicit mentions", async () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          selfChatMode: true,
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
          accounts: {
            work: {
              selfChatMode: false,
            },
          },
        },
      },
    });
    // Per-account override: work account has selfChatMode: false despite root being true
    const { result } = await runGroupGating({
      cfg,
      selfChatMode: false,
      msg: createGroupMessage({
        id: "m-account-override",
        to: "+15550000",
        accountId: "work",
        body: "following up on bot reply",
        timestamp: Date.now(),
        senderE164: "+15551234567",
        senderJid: "15551234567@s.whatsapp.net",
        selfJid: "15551234567@s.whatsapp.net",
        selfE164: "+15551234567",
        replyToId: "m0",
        replyToBody: "bot earlier response",
        replyToSender: "+15551234567",
        replyToSenderJid: "15551234567@s.whatsapp.net",
        replyToSenderE164: "+15551234567",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("uses account-scoped groupPolicy and groupAllowFrom for named-account group gating", async () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          accounts: {
            work: {
              groupPolicy: "allowlist",
              groupAllowFrom: ["+111"],
            },
          },
        },
      },
    });

    const { result } = await runGroupGating({
      cfg,
      msg: createGroupMessage({
        id: "g-account-policy",
        accountId: "work",
        body: "following up",
        senderE164: "+111",
        senderJid: "111@s.whatsapp.net",
        selfJid: "15551234567@s.whatsapp.net",
        selfE164: "+15551234567",
        replyToId: "m0",
        replyToBody: "bot said hi",
        replyToSender: "+15551234567",
        replyToSenderJid: "15551234567@s.whatsapp.net",
        replyToSenderE164: "+15551234567",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("inherits group gating defaults from accounts.default for named accounts", async () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          accounts: {
            default: {
              groupPolicy: "open",
              groups: {
                "*": {
                  requireMention: false,
                },
              },
            },
            work: {},
          },
        },
      },
    });

    const { result } = await runGroupGating({
      cfg,
      msg: createGroupMessage({
        id: "g-default-inheritance",
        accountId: "work",
        body: "plain group message",
        senderE164: "+111",
        senderJid: "111@s.whatsapp.net",
        selfJid: "15551234567@s.whatsapp.net",
        selfE164: "+15551234567",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("preserves allowFrom fallback for named-account group gating when groupAllowFrom is empty", async () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          accounts: {
            work: {
              groupPolicy: "allowlist",
              allowFrom: ["+111"],
              groupAllowFrom: [],
              groups: {
                "*": {
                  requireMention: false,
                },
              },
            },
          },
        },
      },
    });

    const { result } = await runGroupGating({
      cfg,
      msg: createGroupMessage({
        id: "g-empty-group-allow-fallback",
        accountId: "work",
        body: "plain group message",
        senderE164: "+111",
        senderJid: "111@s.whatsapp.net",
        selfJid: "15551234567@s.whatsapp.net",
        selfE164: "+15551234567",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("uses account-scoped allowFrom when bypassing mention gating for owner commands", async () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          allowFrom: ["+999"],
          accounts: {
            work: {
              allowFrom: ["+111"],
            },
          },
        },
      },
    });

    const { result } = await runGroupGating({
      cfg,
      msg: createGroupMessage({
        id: "g-account-owner",
        accountId: "work",
        body: "/new",
        senderE164: "+111",
        senderName: "Owner",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("does not treat group mention gating as self-chat under implicit self fallback", async () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          groups: { "*": { requireMention: true } },
        },
      },
      messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
    });

    const { result, groupHistories } = await runGroupGating({
      cfg,
      msg: createGroupMessage({
        id: "g-other-mention",
        body: "@openclaw please check this",
        mentionedJids: ["15550000000@s.whatsapp.net"],
        selfE164: "+15551234567",
        selfJid: "15551234567@s.whatsapp.net",
      }),
    });

    expect(result.shouldProcess).toBe(false);
    expect(groupHistories.get("whatsapp:default:group:123@g.us")?.length).toBe(1);
  });

  it.each([
    { id: "g-new", command: "/new" },
    { id: "g-status", command: "/status" },
  ])("bypasses mention gating for owner $command in group chats", async ({ id, command }) => {
    const { result } = await runGroupGating({
      cfg: makeOwnerGroupConfig(),
      msg: createGroupMessage({
        id,
        body: command,
        senderE164: "+111",
        senderName: "Owner",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("does not bypass mention gating for non-owner /new in group chats", async () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          allowFrom: ["+999"],
          groups: { "*": { requireMention: true } },
        },
      },
    });

    const { result, groupHistories } = await runGroupGating({
      cfg,
      msg: createGroupMessage({
        id: "g-new-unauth",
        body: "/new",
        senderE164: "+111",
        senderName: "NotOwner",
      }),
    });

    expect(result.shouldProcess).toBe(false);
    expect(groupHistories.get("whatsapp:default:group:123@g.us")?.length).toBe(1);
  });

  it("uses per-agent mention patterns for group gating (routing + mentionPatterns)", async () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          groups: { "*": { requireMention: true } },
        },
      },
      messages: {
        groupChat: { mentionPatterns: ["@global"] },
      },
      agents: {
        list: [
          {
            id: "work",
            groupChat: { mentionPatterns: ["@workbot"] },
          },
        ],
      },
      bindings: [
        {
          agentId: "work",
          match: {
            provider: "whatsapp",
            peer: { kind: "group", id: "123@g.us" },
          },
        },
      ],
    });

    const route = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      peer: { kind: "group", id: "123@g.us" },
    });
    expect(route.agentId).toBe("work");

    const { result: globalMention } = await runGroupGating({
      cfg,
      agentId: route.agentId,
      msg: createGroupMessage({
        id: "g1",
        body: "@global ping",
        senderE164: "+111",
        senderName: "Alice",
      }),
    });
    expect(globalMention.shouldProcess).toBe(false);

    const { result: workMention } = await runGroupGating({
      cfg,
      agentId: route.agentId,
      msg: createGroupMessage({
        id: "g2",
        body: "@workbot ping",
        senderE164: "+222",
        senderName: "Bob",
      }),
    });
    expect(workMention.shouldProcess).toBe(true);
  });

  it("allows group messages when whatsapp groups default disables mention gating", async () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          groups: { "*": { requireMention: false } },
        },
      },
      messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
    });

    const { result } = await runGroupGating({
      cfg,
      msg: createGroupMessage(),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("blocks group messages when whatsapp groups is set without a wildcard", async () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          groups: {
            "999@g.us": { requireMention: false },
          },
        },
      },
    });

    const { result } = await runGroupGating({
      cfg,
      msg: createGroupMessage({
        body: "@workbot ping",
        mentionedJids: ["999@s.whatsapp.net"],
        selfJid: "999@s.whatsapp.net",
      }),
    });

    expect(result.shouldProcess).toBe(false);
  });
});

describe("buildInboundLine", () => {
  it("prefixes group messages with sender", () => {
    const line = buildInboundLine({
      cfg: makeInboundCfg(""),
      agentId: "main",
      msg: createGroupMessage({
        to: "+15550009999",
        accountId: "default",
        body: "ping",
        timestamp: 1700000000000,
        senderJid: "111@s.whatsapp.net",
        senderE164: "+15550001111",
        senderName: "Bob",
      }) as never,
    });

    expect(line).toContain("Bob (+15550001111):");
    expect(line).toContain("ping");
  });

  it("includes reply-to context blocks when replyToBody is present", () => {
    const line = buildInboundLine({
      cfg: makeInboundCfg(""),
      agentId: "main",
      msg: {
        from: "+1555",
        to: "+1555",
        body: "hello",
        chatType: "direct",
        replyToId: "q1",
        replyToBody: "original",
        replyToSender: "+1999",
      } as never,
      envelope: { includeTimestamp: false },
    });

    expect(line).toContain("[Replying to +1999 id:q1]");
    expect(line).toContain("original");
    expect(line).toContain("[/Replying]");
  });

  it("applies the WhatsApp messagePrefix when configured", () => {
    const line = buildInboundLine({
      cfg: makeInboundCfg("[PFX]"),
      agentId: "main",
      msg: {
        from: "+1555",
        to: "+2666",
        body: "ping",
        chatType: "direct",
      } as never,
      envelope: { includeTimestamp: false },
    });

    expect(line).toContain("[PFX] ping");
  });

  it("normalizes direct from labels by stripping whatsapp: prefix", () => {
    const line = buildInboundLine({
      cfg: makeInboundCfg(""),
      agentId: "main",
      msg: {
        from: "whatsapp:+15550001111",
        to: "+2666",
        body: "ping",
        chatType: "direct",
      } as never,
      envelope: { includeTimestamp: false },
    });

    expect(line).toContain("+15550001111");
    expect(line).not.toContain("whatsapp:+15550001111");
  });
});

describe("formatReplyContext", () => {
  it("returns null when replyToBody is missing", () => {
    expect(formatReplyContext({} as never)).toBeNull();
  });

  it("uses unknown sender label when reply sender is absent", () => {
    expect(
      formatReplyContext({
        replyToBody: "original",
      } as never),
    ).toBe("[Replying to unknown sender]\noriginal\n[/Replying]");
  });
});
