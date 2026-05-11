import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetIMessageShortIdState } from "../monitor-reply-cache.js";
import {
  buildIMessageInboundContext,
  describeIMessageEchoDropLog,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";
import { createSelfChatCache } from "./self-chat-cache.js";

describe("resolveIMessageInboundDecision echo detection", () => {
  const cfg = {} as OpenClawConfig;
  type InboundDecisionParams = Parameters<typeof resolveIMessageInboundDecision>[0];

  function createInboundDecisionParams(
    overrides: Omit<Partial<InboundDecisionParams>, "message"> & {
      message?: Partial<InboundDecisionParams["message"]>;
    } = {},
  ): InboundDecisionParams {
    const { message: messageOverrides, ...restOverrides } = overrides;
    const message = {
      id: 42,
      sender: "+15555550123",
      text: "ok",
      is_from_me: false,
      is_group: false,
      ...messageOverrides,
    };
    const messageText = restOverrides.messageText ?? message.text ?? "";
    const bodyText = restOverrides.bodyText ?? messageText;
    const baseParams: Omit<InboundDecisionParams, "message" | "messageText" | "bodyText"> = {
      cfg,
      accountId: "default",
      opts: undefined,
      allowFrom: ["*"],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      selfChatCache: undefined,
      logVerbose: undefined,
    };
    return {
      ...baseParams,
      ...restOverrides,
      message,
      messageText,
      bodyText,
    };
  }

  function resolveDecision(
    overrides: Omit<Partial<InboundDecisionParams>, "message"> & {
      message?: Partial<InboundDecisionParams["message"]>;
    } = {},
  ) {
    return resolveIMessageInboundDecision(createInboundDecisionParams(overrides));
  }

  it("drops inbound messages when outbound message id matches echo cache", async () => {
    const echoHas = vi.fn((_scope: string, lookup: { text?: string; messageId?: string }) => {
      return lookup.messageId === "42";
    });

    const decision = await resolveDecision({
      message: {
        id: 42,
        text: "Reasoning:\n_step_",
      },
      messageText: "Reasoning:\n_step_",
      bodyText: "Reasoning:\n_step_",
      echoCache: { has: echoHas },
    });

    expect(decision).toEqual({ kind: "drop", reason: "echo" });
    expect(echoHas).toHaveBeenNthCalledWith(1, "default:imessage:+15555550123", {
      messageId: "42",
    });
    expect(echoHas).toHaveBeenCalledTimes(1);
  });

  it("matches attachment-only echoes by bodyText placeholder", async () => {
    const echoHas = vi.fn((_scope: string, lookup: { text?: string; messageId?: string }) => {
      return lookup.text === "<media:image>" && lookup.messageId === "42";
    });

    const decision = await resolveDecision({
      message: {
        id: 42,
        text: "",
      },
      messageText: "",
      bodyText: "<media:image>",
      echoCache: { has: echoHas },
    });

    expect(decision).toEqual({ kind: "drop", reason: "echo" });
    expect(echoHas).toHaveBeenNthCalledWith(1, "default:imessage:+15555550123", {
      messageId: "42",
    });
    expect(echoHas).toHaveBeenNthCalledWith(
      2,
      "default:imessage:+15555550123",
      {
        text: "<media:image>",
        messageId: "42",
      },
      undefined,
    );
  });

  it("drops reflected self-chat duplicates after seeing the from-me copy", async () => {
    const selfChatCache = createSelfChatCache();
    const createdAt = "2026-03-02T20:58:10.649Z";

    const fromMeDecision = await resolveDecision({
      message: {
        id: 9641,
        sender: "+15555550123",
        chat_identifier: "+15555550123",
        destination_caller_id: "+15555550123",
        text: "Do you want to report this issue?",
        created_at: createdAt,
        is_from_me: true,
      },
      messageText: "Do you want to report this issue?",
      bodyText: "Do you want to report this issue?",
      selfChatCache,
    });
    expect(fromMeDecision.kind).toBe("dispatch");

    expect(
      await resolveDecision({
        message: {
          id: 9642,
          sender: "+15555550123",
          chat_identifier: "+15555550123",
          text: "Do you want to report this issue?",
          created_at: createdAt,
        },
        messageText: "Do you want to report this issue?",
        bodyText: "Do you want to report this issue?",
        selfChatCache,
      }),
    ).toEqual({ kind: "drop", reason: "self-chat echo" });
  });

  it("does not drop same-text messages when created_at differs", async () => {
    const selfChatCache = createSelfChatCache();

    await resolveDecision({
      message: {
        id: 9641,
        text: "ok",
        created_at: "2026-03-02T20:58:10.649Z",
        is_from_me: true,
      },
      selfChatCache,
    });

    const decision = await resolveDecision({
      message: {
        id: 9642,
        text: "ok",
        created_at: "2026-03-02T20:58:11.649Z",
      },
      selfChatCache,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("keeps self-chat cache scoped to configured group threads", async () => {
    const selfChatCache = createSelfChatCache();
    const groupedCfg = {
      channels: {
        imessage: {
          groups: {
            "123": {},
            "456": {},
          },
        },
      },
    } as OpenClawConfig;
    const createdAt = "2026-03-02T20:58:10.649Z";

    expect(
      await resolveDecision({
        cfg: groupedCfg,
        message: {
          id: 9701,
          chat_id: 123,
          text: "same text",
          created_at: createdAt,
          is_from_me: true,
        },
        selfChatCache,
      }),
    ).toEqual({ kind: "drop", reason: "from me" });

    const decision = await resolveDecision({
      cfg: groupedCfg,
      message: {
        id: 9702,
        chat_id: 456,
        text: "same text",
        created_at: createdAt,
      },
      selfChatCache,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("does not drop other participants in the same group thread", async () => {
    const selfChatCache = createSelfChatCache();
    const createdAt = "2026-03-02T20:58:10.649Z";

    expect(
      await resolveDecision({
        message: {
          id: 9751,
          chat_id: 123,
          text: "same text",
          created_at: createdAt,
          is_from_me: true,
          is_group: true,
        },
        selfChatCache,
      }),
    ).toEqual({ kind: "drop", reason: "from me" });

    const decision = await resolveDecision({
      message: {
        id: 9752,
        chat_id: 123,
        sender: "+15555550999",
        text: "same text",
        created_at: createdAt,
        is_group: true,
      },
      selfChatCache,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("drops group echoes persisted under chat_guid scope", async () => {
    // Outbound `send` to a group keyed by chat_guid persists the echo scope
    // as `${accountId}:chat_guid:${chatGuid}` (see send.ts:resolveOutboundEchoScope).
    // The inbound side has chat_id, chat_guid, and chat_identifier all
    // populated by chat.db. Without the multi-scope check, the chat_guid-keyed
    // echo would never be matched against the chat_id-only inbound scope and
    // the agent would react to its own message.
    const echoHas = vi.fn((scope: string, lookup: { text?: string; messageId?: string }) => {
      return scope === "default:chat_guid:iMessage;+;chat0000" && lookup.messageId === "9001";
    });

    const decision = await resolveDecision({
      message: {
        id: 9001,
        chat_id: 42,
        chat_guid: "iMessage;+;chat0000",
        chat_identifier: "chat0000",
        sender: "+15555550123",
        text: "echo",
        is_group: true,
      },
      messageText: "echo",
      bodyText: "echo",
      echoCache: { has: echoHas },
    });

    expect(decision).toEqual({ kind: "drop", reason: "echo" });
    // The match should land on the chat_guid scope variant.
    const calls = echoHas.mock.calls.map(([scope]) => scope);
    expect(calls).toContain("default:chat_guid:iMessage;+;chat0000");
  });

  it("drops group echoes persisted under chat_identifier scope", async () => {
    const echoHas = vi.fn((scope: string, lookup: { text?: string; messageId?: string }) => {
      return scope === "default:chat_identifier:chat0000" && lookup.messageId === "9001";
    });

    const decision = await resolveDecision({
      message: {
        id: 9001,
        chat_id: 42,
        chat_guid: "iMessage;+;chat0000",
        chat_identifier: "chat0000",
        sender: "+15555550123",
        text: "echo",
        is_group: true,
      },
      messageText: "echo",
      bodyText: "echo",
      echoCache: { has: echoHas },
    });

    expect(decision).toEqual({ kind: "drop", reason: "echo" });
    const calls = echoHas.mock.calls.map(([scope]) => scope);
    expect(calls).toContain("default:chat_identifier:chat0000");
  });

  it("drops group echoes persisted under chat_id scope (baseline)", async () => {
    const echoHas = vi.fn((scope: string, lookup: { text?: string; messageId?: string }) => {
      return scope === "default:chat_id:42" && lookup.messageId === "9001";
    });

    const decision = await resolveDecision({
      message: {
        id: 9001,
        chat_id: 42,
        chat_guid: "iMessage;+;chat0000",
        chat_identifier: "chat0000",
        sender: "+15555550123",
        text: "echo",
        is_group: true,
      },
      messageText: "echo",
      bodyText: "echo",
      echoCache: { has: echoHas },
    });

    expect(decision).toEqual({ kind: "drop", reason: "echo" });
    const calls = echoHas.mock.calls.map(([scope]) => scope);
    expect(calls).toContain("default:chat_id:42");
  });

  it("does not drop a group inbound when echo cache holds an unrelated chat_guid", async () => {
    const echoHas = vi.fn(
      (scope: string, lookup: { text?: string; messageId?: string }) =>
        scope === "default:chat_guid:iMessage;+;OTHER" && lookup.messageId === "9001",
    );

    const decision = await resolveDecision({
      message: {
        id: 9001,
        chat_id: 42,
        chat_guid: "iMessage;+;chat0000",
        chat_identifier: "chat0000",
        sender: "+15555550123",
        text: "fresh inbound",
        is_group: true,
      },
      messageText: "fresh inbound",
      bodyText: "fresh inbound",
      echoCache: { has: echoHas },
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("sanitizes reflected duplicate previews before logging", async () => {
    const selfChatCache = createSelfChatCache();
    const logVerbose = vi.fn();
    const createdAt = "2026-03-02T20:58:10.649Z";
    const bodyText = "line-1\nline-2\t\u001b[31mred";

    await resolveDecision({
      message: {
        id: 9801,
        sender: "+15555550123",
        chat_identifier: "+15555550123",
        destination_caller_id: "+15555550123",
        text: bodyText,
        created_at: createdAt,
        is_from_me: true,
      },
      messageText: bodyText,
      bodyText,
      selfChatCache,
      logVerbose,
    });

    await resolveDecision({
      message: {
        id: 9802,
        sender: "+15555550123",
        chat_identifier: "+15555550123",
        text: bodyText,
        created_at: createdAt,
      },
      messageText: bodyText,
      bodyText,
      selfChatCache,
      logVerbose,
    });

    expect(logVerbose).toHaveBeenCalledWith(
      `imessage: dropping self-chat reflected duplicate: "${sanitizeTerminalText(bodyText)}"`,
    );
  });
});

describe("describeIMessageEchoDropLog", () => {
  it("includes message id when available", () => {
    expect(
      describeIMessageEchoDropLog({
        messageText: "Reasoning:\n_step_",
        messageId: "abc-123",
      }),
    ).toContain("id=abc-123");
  });
});

describe("buildIMessageInboundContext", () => {
  it("keeps numeric row id and provider GUID separately for action tooling", async () => {
    const decision = await resolveIMessageInboundDecision({
      cfg: {} as OpenClawConfig,
      accountId: "default",
      message: {
        id: 12345,
        guid: "p:0/GUID-current",
        sender: "+15555550123",
        text: "Hello",
        is_from_me: false,
        is_group: false,
      },
      opts: undefined,
      messageText: "Hello",
      bodyText: "Hello",
      allowFrom: ["*"],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      selfChatCache: undefined,
      logVerbose: undefined,
    });
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }

    const { ctxPayload } = buildIMessageInboundContext({
      cfg: {} as OpenClawConfig,
      decision,
      message: {
        id: 12345,
        guid: "p:0/GUID-current",
        sender: "+15555550123",
        text: "Hello",
        is_from_me: false,
        is_group: false,
      },
      historyLimit: 0,
      groupHistories: new Map(),
    });

    expect(ctxPayload.MessageSid).toBe("1");
    expect(ctxPayload.MessageSidFull).toBe("p:0/GUID-current");
  });
});

describe("resolveIMessageInboundDecision command auth", () => {
  const cfg = {} as OpenClawConfig;
  const resolveDmCommandDecision = (params: {
    messageId: number;
    storeAllowFrom: string[];
    dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
    allowFrom?: string[];
  }) =>
    resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: params.messageId,
        sender: "+15555550123",
        text: "/status",
        is_from_me: false,
        is_group: false,
      },
      opts: undefined,
      messageText: "/status",
      bodyText: "/status",
      allowFrom: params.allowFrom ?? [],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: params.dmPolicy ?? "open",
      storeAllowFrom: params.storeAllowFrom,
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      logVerbose: undefined,
    });

  it("does not auto-authorize DM commands in open mode without allowlists", async () => {
    const decision = await resolveDmCommandDecision({
      messageId: 100,
      storeAllowFrom: [],
    });

    expect(decision).toEqual({ kind: "drop", reason: "dmPolicy blocked" });
  });

  it("authorizes DM commands for senders in pairing-mode store allowlist", async () => {
    const decision = await resolveDmCommandDecision({
      messageId: 101,
      dmPolicy: "pairing",
      storeAllowFrom: ["+15555550123"],
    });

    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.commandAuthorized).toBe(true);
  });
});

describe("buildIMessageInboundContext MessageSid handling (rowid-leak regression)", () => {
  let tempStateDir: string;
  let priorStateDir: string | undefined;
  beforeAll(() => {
    tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-inbound-"));
    priorStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
  });
  afterAll(() => {
    if (priorStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = priorStateDir;
    }
    fs.rmSync(tempStateDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    _resetIMessageShortIdState();
    try {
      fs.rmSync(path.join(tempStateDir, "imessage", "reply-cache.jsonl"), { force: true });
    } catch {
      // best-effort
    }
  });

  function buildParams(messageOverrides: Partial<{ id: number; guid: string }>) {
    const decision = {
      kind: "dispatch" as const,
      route: { accountId: "default", agentId: "lobster", sessionKey: "k", mainSessionKey: "mk" },
      isGroup: false,
      sender: "+15555550123",
      senderId: "+15555550123",
      senderNormalized: "+15555550123",
      historyKey: "h",
      chatId: 3,
      chatGuid: "any;-;+15555550123",
      chatIdentifier: "+15555550123",
      replyContext: undefined,
      isCommand: false,
      commandAuthorized: false,
    };
    return {
      cfg: {} as OpenClawConfig,
      decision: decision as unknown as Parameters<
        typeof buildIMessageInboundContext
      >[0]["decision"],
      message: { sender: "+15555550123", text: "hi", ...messageOverrides },
      historyLimit: 0,
      groupHistories: new Map(),
    } as unknown as Parameters<typeof buildIMessageInboundContext>[0];
  }

  it("uses the gateway-allocated shortId when the inbound has a guid", () => {
    const { ctxPayload } = buildIMessageInboundContext(
      buildParams({ id: 999, guid: "FAB-INBOUND-1" }),
    );
    // First inbound → shortId "1". The chat.db rowid 999 must NOT leak.
    expect(ctxPayload.MessageSid).toBe("1");
  });

  it("does not leak chat.db ROWIDs as MessageSid when the guid is missing", () => {
    // Pre-fix bug: when rememberedMessage was nil/empty, MessageSid fell
    // back to `String(message.id)` — leaking chat.db ROWID into the agent's
    // short-id namespace. Agent then tried to react to a phantom shortId
    // that the resolver couldn't find ("13 is no longer available").
    const { ctxPayload } = buildIMessageInboundContext(buildParams({ id: 13, guid: undefined }));
    expect(ctxPayload.MessageSid).toBeUndefined();
    // Critically: never the rowid as a string.
    expect(ctxPayload.MessageSid).not.toBe("13");
  });

  it("does not leak chat.db ROWIDs even when the guid is whitespace", () => {
    const { ctxPayload } = buildIMessageInboundContext(buildParams({ id: 13, guid: "   " }));
    expect(ctxPayload.MessageSid).toBeUndefined();
  });
});
