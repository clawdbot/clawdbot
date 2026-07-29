// Signal tests cover event handler.mention gating plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { buildDispatchInboundCaptureMock } from "openclaw/plugin-sdk/channel-contract-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { HistoryMediaEntry } from "openclaw/plugin-sdk/reply-history";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatSignalMediaText } from "../media-text.js";

type SignalMsgContext = Pick<MsgContext, "Body" | "WasMentioned"> & {
  Body?: string;
  WasMentioned?: boolean;
};

let capturedCtx: SignalMsgContext | undefined;

function getCapturedCtx() {
  if (!capturedCtx) {
    throw new Error("expected captured Signal MsgContext");
  }
  return capturedCtx;
}

function getGroupHistoryEntries(
  groupHistories: Map<
    string,
    Array<{ sender?: string; body?: string; media?: HistoryMediaEntry[] }>
  >,
  groupId = "g1",
) {
  const entries = groupHistories.get(groupId);
  if (!entries) {
    throw new Error(`expected pending history for ${groupId}`);
  }
  return entries;
}

vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return buildDispatchInboundCaptureMock(actual, (ctx) => {
    capturedCtx = ctx as SignalMsgContext;
  });
});

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  type RunParams = Parameters<typeof actual.runChannelInboundEvent>[0];
  return {
    ...actual,
    runChannelInboundEvent: async (params: RunParams) => {
      const input = await params.adapter.ingest(params.raw);
      if (!input) {
        return { admission: { kind: "drop" as const, reason: "ingest-null" }, dispatched: false };
      }
      const eventClass = (await params.adapter.classify?.(input)) ?? {
        kind: "message" as const,
        canStartAgentTurn: true,
      };
      const preflight = (await params.adapter.preflight?.(input, eventClass)) ?? {};
      const resolved = await params.adapter.resolveTurn(
        input,
        eventClass,
        "kind" in preflight ? { admission: preflight } : preflight,
      );
      if (!("route" in resolved) || !("delivery" in resolved)) {
        throw new Error("expected assembled Signal channel turn plan");
      }
      const result = await actual.runPreparedInboundReply({
        channel: resolved.channel,
        accountId: resolved.accountId,
        routeSessionKey: resolved.route.sessionKey,
        storePath: "/tmp/openclaw/signal-sessions.json",
        ctxPayload: resolved.ctxPayload,
        recordInboundSession: async () => {},
        afterRecord: resolved.afterRecord,
        record: resolved.record,
        history: resolved.history,
        admission: resolved.admission,
        botLoopProtection: resolved.botLoopProtection,
        runDispatch: async () => {
          capturedCtx = resolved.ctxPayload as SignalMsgContext;
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        },
      });
      await params.adapter.onFinalize?.(result);
      return result;
    },
  };
});

const [
  { createBaseSignalEventHandlerDeps, createSignalReceiveEvent },
  { createSignalEventHandler },
  { renderSignalMentions, resolveSignalMentionFacts },
  { resolveSignalReplyContextWithPersistence },
] = await Promise.all([
  import("./event-handler.test-harness.js"),
  import("./event-handler.js"),
  import("./mentions.js"),
  import("../reply-authors.js"),
]);

type GroupEventOpts = {
  message?: string;
  attachments?: unknown[];
  quoteText?: string;
  timestamp?: number;
  mentions?: Array<{
    uuid?: string;
    number?: string;
    start?: number;
    length?: number;
  }> | null;
};

function makeGroupEvent(opts: GroupEventOpts) {
  return createSignalReceiveEvent({
    ...(opts.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
    dataMessage: {
      message: opts.message ?? "",
      attachments: opts.attachments ?? [],
      quote: opts.quoteText ? { text: opts.quoteText } : undefined,
      mentions: opts.mentions ?? undefined,
      groupInfo: { groupId: "g1", groupName: "Test Group" },
    },
  });
}

function createMentionHandler(params: {
  requireMention: boolean;
  mentionPattern?: string | null;
  historyLimit?: number;
  groupHistories?: ReturnType<typeof createBaseSignalEventHandlerDeps>["groupHistories"];
  account?: string;
  accountUuid?: string;
}) {
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg: createSignalConfig({
        requireMention: params.requireMention,
        mentionPattern: params.mentionPattern,
      }),
      ...(typeof params.historyLimit === "number" ? { historyLimit: params.historyLimit } : {}),
      ...(params.groupHistories ? { groupHistories: params.groupHistories } : {}),
      ...(params.account ? { account: params.account } : {}),
      ...(params.accountUuid ? { accountUuid: params.accountUuid } : {}),
    }),
  );
}

function createMentionGatedHistoryHandler() {
  const groupHistories = new Map();
  const handler = createMentionHandler({ requireMention: true, historyLimit: 5, groupHistories });
  return { handler, groupHistories };
}

function createSignalConfig(params: { requireMention: boolean; mentionPattern?: string | null }) {
  const mentionPatterns = params.mentionPattern === null ? [] : [params.mentionPattern ?? "@bot"];
  return {
    messages: {
      inbound: { debounceMs: 0 },
      groupChat: { mentionPatterns },
    },
    channels: {
      signal: {
        groups: { "*": { requireMention: params.requireMention } },
      },
    },
  } as unknown as OpenClawConfig;
}

async function expectSkippedGroupHistory(
  opts: GroupEventOpts,
  expectedBody: string,
  expectedMediaText = "",
) {
  capturedCtx = undefined;
  const { handler, groupHistories } = createMentionGatedHistoryHandler();
  await handler(makeGroupEvent(opts));
  expect(capturedCtx).toBeUndefined();
  const entries = getGroupHistoryEntries(groupHistories);
  expect(entries).toHaveLength(1);
  const entry = expectDefined(entries[0], "Signal group history entry");
  expect(entry.body).toBe(expectedBody);
  expect(formatSignalMediaText(entry.media ?? [])).toBe(expectedMediaText);
}

describe("signal mention gating", () => {
  beforeEach(() => {
    capturedCtx = undefined;
  });

  it("drops group messages without mention when requireMention is configured", async () => {
    const handler = createMentionHandler({ requireMention: true });

    await handler(makeGroupEvent({ message: "hello everyone" }));
    expect(capturedCtx).toBeUndefined();
  });

  it("allows group messages with mention when requireMention is configured", async () => {
    const handler = createMentionHandler({ requireMention: true });

    await handler(makeGroupEvent({ message: "hey @bot what's up" }));
    expect(getCapturedCtx().WasMentioned).toBe(true);
  });

  it("sets WasMentioned=false for group messages without mention when requireMention is off", async () => {
    const handler = createMentionHandler({ requireMention: false });

    await handler(makeGroupEvent({ message: "hello everyone" }));
    expect(getCapturedCtx().WasMentioned).toBe(false);
  });

  it("allows explicitly configured Signal groups by group id without a mention", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: {
            inbound: { debounceMs: 0 },
            groupChat: { mentionPatterns: ["@bot"] },
          },
          channels: {
            signal: {
              groupPolicy: "allowlist",
              groupAllowFrom: ["group:g1"],
              groups: { g1: {} },
            },
          },
        } as unknown as OpenClawConfig,
        groupPolicy: "allowlist",
        groupAllowFrom: ["group:g1"],
      }),
    );

    await handler(makeGroupEvent({ message: "hello everyone" }));
    expect(getCapturedCtx().WasMentioned).toBe(false);
  });

  it("records pending history for skipped group messages", async () => {
    const { handler, groupHistories } = createMentionGatedHistoryHandler();
    await handler(makeGroupEvent({ message: "hello from alice" }));
    expect(capturedCtx).toBeUndefined();
    const entries = getGroupHistoryEntries(groupHistories);
    expect(entries).toHaveLength(1);
    const entry = expectDefined(entries[0], "Signal group history entry");
    expect(entry.sender).toBe("Alice");
    expect(entry.body).toBe("hello from alice");
  });

  it("records edited target reply authors for skipped group messages", async () => {
    const { handler } = createMentionGatedHistoryHandler();

    await handler(
      createSignalReceiveEvent({
        timestamp: 1700000000999,
        editMessage: {
          targetSentTimestamp: 1700000000000,
          dataMessage: {
            timestamp: 1700000000999,
            message: "edited without mention",
            attachments: [],
            groupInfo: { groupId: "g1", groupName: "Test Group" },
          },
        },
      }),
    );

    expect(capturedCtx).toBeUndefined();
    await expect(
      resolveSignalReplyContextWithPersistence({
        accountId: "default",
        to: "group:g1",
        replyToId: "1700000000000",
      }),
    ).resolves.toEqual({ author: "+15550001111", body: "edited without mention" });
  });

  it("records a structured fact for skipped attachment-only group messages", async () => {
    await expectSkippedGroupHistory(
      { message: "", attachments: [{ id: "a1" }], timestamp: 1700000000123 },
      "",
      "<media:attachment>",
    );
    await expect(
      resolveSignalReplyContextWithPersistence({
        accountId: "default",
        to: "group:g1",
        replyToId: "1700000000123",
      }),
    ).resolves.toEqual({
      author: "+15550001111",
      media: [{ contentType: undefined, kind: "unknown" }],
    });
  });

  it("normalizes mixed-case parameterized attachment MIME in skipped pending history", async () => {
    const groupHistories = new Map();
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: createSignalConfig({ requireMention: true }),
        historyLimit: 5,
        groupHistories,
        ignoreAttachments: false,
      }),
    );

    await handler(
      makeGroupEvent({
        message: "",
        attachments: [{ contentType: " Audio/Ogg; codecs=opus " }],
      }),
    );

    expect(capturedCtx).toBeUndefined();
    const entries = getGroupHistoryEntries(groupHistories);
    expect(entries).toHaveLength(1);
    const entry = expectDefined(entries[0], "Signal audio history entry");
    expect(entry.body).toBe("");
    expect(formatSignalMediaText(entry.media ?? [])).toBe("<media:audio>");
  });

  it("summarizes multiple skipped attachments with stable file count wording", async () => {
    const groupHistories = new Map();
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: createSignalConfig({ requireMention: true }),
        historyLimit: 5,
        groupHistories,
        ignoreAttachments: false,
        fetchAttachment: async ({ attachment }) => ({
          path: `/tmp/${String(attachment.id)}.bin`,
        }),
      }),
    );

    await handler(
      makeGroupEvent({
        message: "",
        attachments: [{ id: "a1" }, { id: "a2" }],
      }),
    );

    expect(capturedCtx).toBeUndefined();
    const entries = getGroupHistoryEntries(groupHistories);
    expect(entries).toHaveLength(1);
    const entry = expectDefined(entries[0], "Signal attachment history entry");
    expect(entry.body).toBe("");
    expect(formatSignalMediaText(entry.media ?? [])).toBe("[2 files attached]");
  });

  it("records quote text in pending history for skipped quote-only group messages", async () => {
    await expectSkippedGroupHistory({ message: "", quoteText: "quoted context" }, "quoted context");
  });

  it("bypasses mention gating for authorized control commands", async () => {
    const handler = createMentionHandler({ requireMention: true });

    await handler(makeGroupEvent({ message: "/help" }));
    expect(getCapturedCtx().Body).toContain("/help");
  });

  it("hydrates mention placeholders before trimming so offsets stay aligned", async () => {
    const handler = createMentionHandler({ requireMention: false });

    const placeholder = "\uFFFC";
    const message = `\n${placeholder} hi ${placeholder}`;
    const firstStart = message.indexOf(placeholder);
    const secondStart = message.indexOf(placeholder, firstStart + 1);

    await handler(
      makeGroupEvent({
        message,
        mentions: [
          { uuid: "123e4567", start: firstStart, length: placeholder.length },
          { number: "+15550002222", start: secondStart, length: placeholder.length },
        ],
      }),
    );

    const body = getCapturedCtx().Body ?? "";
    expect(body).toContain("@123e4567 hi @+15550002222");
    expect(body).not.toContain(placeholder);
  });

  it("counts mention metadata replacements toward requireMention gating", async () => {
    const handler = createMentionHandler({
      requireMention: true,
      mentionPattern: "@123e4567",
    });

    const placeholder = "\uFFFC";
    const message = ` ${placeholder} ping`;
    const start = message.indexOf(placeholder);

    await handler(
      makeGroupEvent({
        message,
        mentions: [{ uuid: "123e4567", start, length: placeholder.length }],
      }),
    );

    expect(getCapturedCtx()?.Body ?? "").toContain("@123e4567");
    expect(getCapturedCtx().WasMentioned).toBe(true);
  });

  it("allows native bot UUID mentions without a text mention pattern", async () => {
    const handler = createMentionHandler({
      requireMention: true,
      mentionPattern: null,
      accountUuid: "bot-uuid",
    });
    await handler(
      makeGroupEvent({
        message: "Hi X!",
        mentions: [{ uuid: "bot-uuid", start: 3, length: 1 }],
      }),
    );

    expect(getCapturedCtx()?.Body).toContain("Hi X!");
    expect(getCapturedCtx().WasMentioned).toBe(true);
  });

  it("allows native bot phone mentions after E.164 normalization", async () => {
    const handler = createMentionHandler({
      requireMention: true,
      mentionPattern: null,
      account: "+15550002222",
    });
    const placeholder = "\uFFFC";

    await handler(
      makeGroupEvent({
        message: `please ${placeholder}`,
        mentions: [{ number: "1 (555) 000-2222", start: 7, length: placeholder.length }],
      }),
    );

    expect(getCapturedCtx()?.Body ?? "").toContain("@1 (555) 000-2222");
    expect(getCapturedCtx().WasMentioned).toBe(true);
  });

  it("keeps native mentions of other participants silent while recording pending context", async () => {
    const groupHistories = new Map();
    const handler = createMentionHandler({
      requireMention: true,
      mentionPattern: null,
      accountUuid: "bot-uuid",
      groupHistories,
    });
    const placeholder = "\uFFFC";

    await handler(
      makeGroupEvent({
        message: `${placeholder} can you check?`,
        mentions: [{ uuid: "other-user", start: 0, length: placeholder.length }],
      }),
    );

    expect(capturedCtx).toBeUndefined();
    const entries = getGroupHistoryEntries(groupHistories);
    expect(entries).toHaveLength(1);
    expect(expectDefined(entries[0], "Signal native mention history entry").body).toBe(
      "@other-user can you check?",
    );
  });

  it("does not let an authorized command bypass a native mention of another participant", async () => {
    const groupHistories = new Map();
    const handler = createMentionHandler({
      requireMention: true,
      mentionPattern: null,
      accountUuid: "bot-uuid",
      groupHistories,
    });
    const placeholder = "\uFFFC";

    await handler(
      makeGroupEvent({
        message: `/help ${placeholder}`,
        mentions: [{ uuid: "other-user", start: 6, length: placeholder.length }],
      }),
    );

    expect(capturedCtx).toBeUndefined();
    const entries = getGroupHistoryEntries(groupHistories);
    expect(entries).toHaveLength(1);
    expect(expectDefined(entries[0], "Signal command mention history entry").body).toBe(
      "/help @other-user",
    );
  });

  it("does not accept malformed matching native mention metadata as a bot mention", async () => {
    const groupHistories = new Map();
    const handler = createMentionHandler({
      requireMention: true,
      mentionPattern: null,
      accountUuid: "bot-uuid",
      groupHistories,
    });

    await handler(
      makeGroupEvent({
        message: "plain ping",
        mentions: [{ uuid: "bot-uuid", start: 99, length: 1 }],
      }),
    );

    expect(capturedCtx).toBeUndefined();
    const entries = getGroupHistoryEntries(groupHistories);
    expect(entries).toHaveLength(1);
    expect(expectDefined(entries[0], "Signal malformed mention history entry").body).toBe(
      "plain ping",
    );
  });

  it("preserves no-detector behavior when no text pattern or bot identity is configured", async () => {
    const handler = createMentionHandler({ requireMention: true, mentionPattern: null });

    await handler(makeGroupEvent({ message: "hello everyone" }));

    expect(getCapturedCtx().WasMentioned).toBe(false);
  });
});

describe("renderSignalMentions", () => {
  const PLACEHOLDER = "\uFFFC";

  it("returns the original message when no mentions are provided", () => {
    const message = `${PLACEHOLDER} ping`;
    expect(renderSignalMentions(message, null)).toBe(message);
    expect(renderSignalMentions(message, [])).toBe(message);
  });

  it("replaces placeholder code points using mention metadata", () => {
    const message = `${PLACEHOLDER} hi ${PLACEHOLDER}!`;
    const normalized = renderSignalMentions(message, [
      { uuid: "abc-123", start: 0, length: 1 },
      { number: "+15550005555", start: message.lastIndexOf(PLACEHOLDER), length: 1 },
    ]);

    expect(normalized).toBe("@abc-123 hi @+15550005555!");
  });

  it("skips mentions that lack identifiers or out-of-bounds spans", () => {
    const message = `${PLACEHOLDER} hi`;
    const normalized = renderSignalMentions(message, [
      { name: "ignored" },
      { uuid: "valid", start: 0, length: 1 },
      { number: "+1555", start: 999, length: 1 },
    ]);

    expect(normalized).toBe("@valid hi");
  });

  it("clamps and truncates fractional mention offsets", () => {
    const message = `${PLACEHOLDER} ping`;
    const normalized = renderSignalMentions(message, [{ uuid: "valid", start: -0.7, length: 1.9 }]);

    expect(normalized).toBe("@valid ping");
  });
});

describe("resolveSignalMentionFacts", () => {
  const PLACEHOLDER = "\uFFFC";

  it("reports bot, any, and capability facts for valid UUID metadata", () => {
    expect(
      resolveSignalMentionFacts({ accountUuid: "bot-uuid" }, `${PLACEHOLDER} ping`, [
        { uuid: "bot-uuid", start: 0, length: 1 },
      ]),
    ).toEqual({
      canDetectBotMention: true,
      hasAnyMention: true,
      mentionsBot: true,
    });
  });

  it("reports unrelated valid metadata without treating it as a bot mention", () => {
    expect(
      resolveSignalMentionFacts({ accountUuid: "bot-uuid" }, `${PLACEHOLDER} ping`, [
        { uuid: "other-user", start: 0, length: 1 },
      ]),
    ).toEqual({
      canDetectBotMention: true,
      hasAnyMention: true,
      mentionsBot: false,
    });
  });

  it("accepts valid mention metadata over ordinary message text", () => {
    expect(
      resolveSignalMentionFacts({ accountUuid: "bot-uuid" }, "Hi X!", [
        { uuid: "bot-uuid", start: 3, length: 1 },
      ]),
    ).toEqual({
      canDetectBotMention: true,
      hasAnyMention: true,
      mentionsBot: true,
    });
  });

  it("ignores matching metadata whose span is outside the message", () => {
    expect(
      resolveSignalMentionFacts({ accountUuid: "bot-uuid" }, "plain ping", [
        { uuid: "bot-uuid", start: 99, length: 1 },
      ]),
    ).toEqual({
      canDetectBotMention: true,
      hasAnyMention: false,
      mentionsBot: false,
    });
  });

  it("keeps mention facts but no bot detection capability without account identity", () => {
    expect(
      resolveSignalMentionFacts({}, `${PLACEHOLDER} ping`, [
        { uuid: "bot-uuid", start: 0, length: 1 },
      ]),
    ).toEqual({
      canDetectBotMention: false,
      hasAnyMention: true,
      mentionsBot: false,
    });
  });
});
