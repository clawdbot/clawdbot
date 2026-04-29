import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
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

  it("drops inbound messages when outbound message id matches echo cache", () => {
    const echoHas = vi.fn((_scope: string, lookup: { text?: string; messageId?: string }) => {
      return lookup.messageId === "42";
    });

    const decision = resolveDecision({
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

  it("matches attachment-only echoes by bodyText placeholder", () => {
    const echoHas = vi.fn((_scope: string, lookup: { text?: string; messageId?: string }) => {
      return lookup.text === "<media:image>" && lookup.messageId === "42";
    });

    const decision = resolveDecision({
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

  it("drops reflected self-chat duplicates after seeing the from-me copy", () => {
    const selfChatCache = createSelfChatCache();
    const createdAt = "2026-03-02T20:58:10.649Z";

    expect(
      resolveDecision({
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
      }),
    ).toMatchObject({ kind: "dispatch" });

    expect(
      resolveDecision({
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

  it("does not drop same-text messages when created_at differs", () => {
    const selfChatCache = createSelfChatCache();

    resolveDecision({
      message: {
        id: 9641,
        text: "ok",
        created_at: "2026-03-02T20:58:10.649Z",
        is_from_me: true,
      },
      selfChatCache,
    });

    const decision = resolveDecision({
      message: {
        id: 9642,
        text: "ok",
        created_at: "2026-03-02T20:58:11.649Z",
      },
      selfChatCache,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("keeps self-chat cache scoped to configured group threads", () => {
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
      resolveDecision({
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

    const decision = resolveDecision({
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

  it("does not drop other participants in the same group thread", () => {
    const selfChatCache = createSelfChatCache();
    const createdAt = "2026-03-02T20:58:10.649Z";

    expect(
      resolveDecision({
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

    const decision = resolveDecision({
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

  it("sanitizes reflected duplicate previews before logging", () => {
    const selfChatCache = createSelfChatCache();
    const logVerbose = vi.fn();
    const createdAt = "2026-03-02T20:58:10.649Z";
    const bodyText = "line-1\nline-2\t\u001b[31mred";

    resolveDecision({
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

    resolveDecision({
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

  it("does not auto-authorize DM commands in open mode without allowlists", () => {
    const decision = resolveDmCommandDecision({
      messageId: 100,
      storeAllowFrom: [],
    });

    expect(decision).toEqual({ kind: "drop", reason: "dmPolicy blocked" });
  });

  it("authorizes DM commands for senders in pairing-mode store allowlist", () => {
    const decision = resolveDmCommandDecision({
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
