import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedBlueBubblesAccount } from "./accounts.js";
import { fetchBlueBubblesHistory } from "./history.js";
import { createBlueBubblesDebounceRegistry } from "./monitor-debounce.js";
import type { NormalizedWebhookMessage } from "./monitor-normalize.js";
import { resetBlueBubblesSelfChatCache } from "./monitor-self-chat-cache.js";
import { resolveBlueBubblesMessageId } from "./monitor.js";
import {
  createMockAccount,
  createMockRequest,
  createNewMessagePayloadForTest,
  createTimestampedMessageReactionPayloadForTest,
  createTimestampedNewMessagePayloadForTest,
  dispatchWebhookPayloadForTest,
  dispatchWebhookRequestForTest,
  setupWebhookTargetForTest,
  setupWebhookTargetsForTest,
  trackWebhookRegistrationForTest,
} from "./monitor.webhook.test-helpers.js";
import {
  resetBlueBubblesParticipantContactNameCacheForTest,
  setBlueBubblesParticipantContactDepsForTest,
} from "./participant-contact-names.js";
import type { OpenClawConfig, PluginRuntime } from "./runtime-api.js";
import { createBlueBubblesFetchGuardPassthroughInstaller } from "./test-harness.js";
import {
  createBlueBubblesMonitorTestRuntime,
  EMPTY_DISPATCH_RESULT,
  resetBlueBubblesMonitorTestState,
  type DispatchReplyParams,
} from "./test-support/monitor-test-support.js";
import { _setFetchGuardForTesting } from "./types.js";

// Mock dependencies
vi.mock("./send.js", () => ({
  resolveChatGuidForTarget: vi.fn().mockResolvedValue("iMessage;-;+15551234567"),
  sendMessageBlueBubbles: vi.fn().mockResolvedValue({ messageId: "msg-123" }),
}));

vi.mock("./chat.js", () => ({
  markBlueBubblesChatRead: vi.fn().mockResolvedValue(undefined),
  sendBlueBubblesTyping: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./attachments.js", () => ({
  downloadBlueBubblesAttachment: vi.fn().mockResolvedValue({
    buffer: Buffer.from("test"),
    contentType: "image/jpeg",
  }),
}));

vi.mock("./reactions.js", async () => {
  const actual = await vi.importActual<typeof import("./reactions.js")>("./reactions.js");
  return {
    ...actual,
    sendBlueBubblesReaction: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("./history.js", () => ({
  fetchBlueBubblesHistory: vi.fn().mockResolvedValue({ entries: [], resolved: true }),
}));

// Mock runtime
const mockEnqueueSystemEvent = vi.fn();
const mockBuildPairingReply = vi.fn(() => "Pairing code: TESTCODE");
const mockReadAllowFromStore = vi.fn().mockResolvedValue([]);
const mockUpsertPairingRequest = vi.fn().mockResolvedValue({ code: "TESTCODE", created: true });
const DEFAULT_RESOLVED_AGENT_ROUTE: ReturnType<
  PluginRuntime["channel"]["routing"]["resolveAgentRoute"]
> = {
  agentId: "main",
  channel: "bluebubbles",
  accountId: "default",
  sessionKey: "agent:main:bluebubbles:dm:+15551234567",
  mainSessionKey: "agent:main:main",
  lastRoutePolicy: "main",
  matchedBy: "default",
};
const mockResolveAgentRoute = vi.fn(() => DEFAULT_RESOLVED_AGENT_ROUTE);
const mockBuildMentionRegexes = vi.fn(() => [/\bbert\b/i]);
const mockMatchesMentionPatterns = vi.fn((text: string, regexes: RegExp[]) =>
  regexes.some((r) => r.test(text)),
);
const mockMatchesMentionWithExplicit = vi.fn(
  (params: { text: string; mentionRegexes: RegExp[]; explicitWasMentioned?: boolean }) => {
    if (params.explicitWasMentioned) {
      return true;
    }
    return params.mentionRegexes.some((regex) => regex.test(params.text));
  },
);
const mockResolveRequireMention = vi.fn(() => false);
const mockResolveGroupPolicy = vi.fn(() => ({
  allowlistEnabled: false,
  allowed: true,
}));
const mockDispatchReplyWithBufferedBlockDispatcher = vi.fn(
  async (_params: DispatchReplyParams) => EMPTY_DISPATCH_RESULT,
);
const mockHasControlCommand = vi.fn(() => false);
const mockResolveCommandAuthorizedFromAuthorizers = vi.fn(() => false);
const mockSaveMediaBuffer = vi.fn().mockResolvedValue({
  id: "test-media.jpg",
  path: "/tmp/test-media.jpg",
  size: Buffer.byteLength("test"),
  contentType: "image/jpeg",
});
const mockResolveStorePath = vi.fn(() => "/tmp/sessions.json");
const mockReadSessionUpdatedAt = vi.fn(() => undefined);
const mockResolveEnvelopeFormatOptions = vi.fn(() => ({}));
const mockFormatAgentEnvelope = vi.fn((opts: { body: string }) => opts.body);
const mockFormatInboundEnvelope = vi.fn((opts: { body: string }) => opts.body);
const mockChunkMarkdownText = vi.fn((text: string) => [text]);
const mockChunkByNewline = vi.fn((text: string) => (text ? [text] : []));
const mockChunkTextWithMode = vi.fn((text: string) => (text ? [text] : []));
const mockChunkMarkdownTextWithMode = vi.fn((text: string) => (text ? [text] : []));
const mockResolveChunkMode = vi.fn(() => "length" as const);
const mockFetchBlueBubblesHistory = vi.mocked(fetchBlueBubblesHistory);
const mockFetch = vi.fn();

function createMockRuntime(): PluginRuntime {
  return createBlueBubblesMonitorTestRuntime({
    enqueueSystemEvent: mockEnqueueSystemEvent,
    chunkMarkdownText: mockChunkMarkdownText,
    chunkByNewline: mockChunkByNewline,
    chunkMarkdownTextWithMode: mockChunkMarkdownTextWithMode,
    chunkTextWithMode: mockChunkTextWithMode,
    resolveChunkMode: mockResolveChunkMode,
    hasControlCommand: mockHasControlCommand,
    dispatchReplyWithBufferedBlockDispatcher: mockDispatchReplyWithBufferedBlockDispatcher,
    formatAgentEnvelope: mockFormatAgentEnvelope,
    formatInboundEnvelope: mockFormatInboundEnvelope,
    resolveEnvelopeFormatOptions: mockResolveEnvelopeFormatOptions,
    resolveAgentRoute: mockResolveAgentRoute,
    buildPairingReply: mockBuildPairingReply,
    readAllowFromStore: mockReadAllowFromStore,
    upsertPairingRequest: mockUpsertPairingRequest,
    saveMediaBuffer: mockSaveMediaBuffer,
    resolveStorePath: mockResolveStorePath,
    readSessionUpdatedAt: mockReadSessionUpdatedAt,
    buildMentionRegexes: mockBuildMentionRegexes,
    matchesMentionPatterns: mockMatchesMentionPatterns,
    matchesMentionWithExplicit: mockMatchesMentionWithExplicit,
    resolveGroupPolicy: mockResolveGroupPolicy,
    resolveRequireMention: mockResolveRequireMention,
    resolveCommandAuthorizedFromAuthorizers: mockResolveCommandAuthorizedFromAuthorizers,
  });
}

function getFirstDispatchCall(): DispatchReplyParams {
  const callArgs = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
  if (!callArgs) {
    throw new Error("expected dispatch call arguments");
  }
  return callArgs;
}

function installTimingAwareInboundDebouncer(core: PluginRuntime) {
  // Use a timing-aware debouncer test double that respects debounceMs/buildKey/shouldDebounce.
  core.channel.debounce.createInboundDebouncer = vi.fn((params: any) => {
    type Item = any;
    const buckets = new Map<
      string,
      { items: Item[]; timer: ReturnType<typeof setTimeout> | null }
    >();

    const flush = async (key: string) => {
      const bucket = buckets.get(key);
      if (!bucket) {
        return;
      }
      if (bucket.timer) {
        clearTimeout(bucket.timer);
        bucket.timer = null;
      }
      const items = bucket.items;
      bucket.items = [];
      if (items.length > 0) {
        try {
          await params.onFlush(items);
        } catch (err) {
          params.onError?.(err);
          throw err;
        }
      }
    };

    return {
      enqueue: async (item: Item) => {
        if (params.shouldDebounce && !params.shouldDebounce(item)) {
          await params.onFlush([item]);
          return;
        }

        const key = params.buildKey(item);
        const existing = buckets.get(key);
        const bucket = existing ?? { items: [], timer: null };
        bucket.items.push(item);
        if (bucket.timer) {
          clearTimeout(bucket.timer);
        }
        bucket.timer = setTimeout(async () => {
          await flush(key);
        }, params.debounceMs);
        buckets.set(key, bucket);
      },
      flushKey: vi.fn(async (key: string) => {
        await flush(key);
      }),
    };
  }) as unknown as PluginRuntime["channel"]["debounce"]["createInboundDebouncer"];
}

function createDebounceTestMessage(
  overrides: Partial<NormalizedWebhookMessage> = {},
): NormalizedWebhookMessage {
  return {
    text: "hello",
    senderId: "+15551234567",
    senderIdExplicit: true,
    isGroup: false,
    ...overrides,
  };
}

describe("BlueBubbles webhook monitor", () => {
  let unregister: () => void;

  function setupWebhookTarget(params?: {
    account?: ReturnType<typeof createMockAccount>;
    config?: OpenClawConfig;
    core?: PluginRuntime;
  }) {
    const registration = trackWebhookRegistrationForTest(
      setupWebhookTargetForTest({
        createCore: createMockRuntime,
        core: params?.core,
        account: params?.account,
        config: params?.config,
      }),
      (nextUnregister) => {
        unregister = nextUnregister;
      },
    );
    return { core: registration.core };
  }

  async function dispatchWebhookPayload(payload: unknown, url = "/bluebubbles-webhook") {
    return (await dispatchWebhookPayloadForTest({ body: payload, url })).res;
  }

  async function dispatchWebhookPayloadDirect(payload: unknown, url = "/bluebubbles-webhook") {
    const { handled } = await dispatchWebhookRequestForTest(
      createMockRequest("POST", url, payload),
    );
    return handled;
  }

  const installFetchGuardPassthrough = createBlueBubblesFetchGuardPassthroughInstaller();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    // The BlueBubblesClient now routes every BB API call through the SSRF
    // guard (mode-2 allowlist for configured hostnames). Install a passthrough
    // that wraps `globalThis.fetch` (our stubbed mockFetch) in a real Response
    // so guarded callers get the same mocked behavior the pre-migration
    // callsites did. (#34749, #59722)
    installFetchGuardPassthrough();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });
    resetBlueBubblesMonitorTestState({
      createRuntime: createMockRuntime,
      fetchHistoryMock: mockFetchBlueBubblesHistory,
      readAllowFromStoreMock: mockReadAllowFromStore,
      upsertPairingRequestMock: mockUpsertPairingRequest,
      resolveRequireMentionMock: mockResolveRequireMention,
      hasControlCommandMock: mockHasControlCommand,
      resolveCommandAuthorizedFromAuthorizersMock: mockResolveCommandAuthorizedFromAuthorizers,
      buildMentionRegexesMock: mockBuildMentionRegexes,
      extraReset: () => {
        resetBlueBubblesSelfChatCache();
        resetBlueBubblesParticipantContactNameCacheForTest();
        setBlueBubblesParticipantContactDepsForTest();
      },
    });
  });

  afterEach(() => {
    unregister?.();
    setBlueBubblesParticipantContactDepsForTest();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    _setFetchGuardForTesting(null);
  });

  describe("DM pairing behavior vs allowFrom", () => {
    it("allows DM from sender in allowFrom list", async () => {
      setupWebhookTarget({
        account: createMockAccount({
          dmPolicy: "allowlist",
          allowFrom: ["+15551234567"],
        }),
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello from allowed sender",
      });

      const res = await dispatchWebhookPayload(payload);

      expect(res.statusCode).toBe(200);
      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });

    it("blocks DM from sender not in allowFrom when dmPolicy=allowlist", async () => {
      setupWebhookTarget({
        account: createMockAccount({
          dmPolicy: "allowlist",
          allowFrom: ["+15559999999"], // Different number
        }),
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello from blocked sender",
      });

      const res = await dispatchWebhookPayload(payload);

      expect(res.statusCode).toBe(200);
      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });

    it("blocks DM when dmPolicy=allowlist and allowFrom is empty", async () => {
      setupWebhookTarget({
        account: createMockAccount({
          dmPolicy: "allowlist",
          allowFrom: [],
        }),
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello from blocked sender",
      });

      const res = await dispatchWebhookPayload(payload);

      expect(res.statusCode).toBe(200);
      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
      expect(mockUpsertPairingRequest).not.toHaveBeenCalled();
    });

    it("triggers pairing flow for unknown sender when dmPolicy=pairing and allowFrom is empty", async () => {
      setupWebhookTarget({
        account: createMockAccount({
          dmPolicy: "pairing",
          allowFrom: [],
        }),
      });

      const payload = createTimestampedNewMessagePayloadForTest();

      await dispatchWebhookPayload(payload);

      expect(mockUpsertPairingRequest).toHaveBeenCalled();
      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });

    it("triggers pairing flow for unknown sender when dmPolicy=pairing", async () => {
      setupWebhookTarget({
        account: createMockAccount({
          dmPolicy: "pairing",
          allowFrom: ["+15559999999"], // Different number than sender
        }),
      });

      const payload = createTimestampedNewMessagePayloadForTest();

      await dispatchWebhookPayload(payload);

      expect(mockUpsertPairingRequest).toHaveBeenCalled();
      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });

    it("does not resend pairing reply when request already exists", async () => {
      mockUpsertPairingRequest.mockResolvedValue({ code: "TESTCODE", created: false });

      setupWebhookTarget({
        account: createMockAccount({
          dmPolicy: "pairing",
          allowFrom: ["+15559999999"], // Different number than sender
        }),
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello again",
        guid: "msg-2",
      });

      await dispatchWebhookPayload(payload);

      expect(mockUpsertPairingRequest).toHaveBeenCalled();
      // Should not send pairing reply since created=false
      const { sendMessageBlueBubbles } = await import("./send.js");
      expect(sendMessageBlueBubbles).not.toHaveBeenCalled();
    });

    it("allows all DMs when dmPolicy=open", async () => {
      setupWebhookTarget({
        account: createMockAccount({
          dmPolicy: "open",
          allowFrom: [],
        }),
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello from anyone",
        handle: { address: "+15559999999" },
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });

    it("blocks all DMs when dmPolicy=disabled", async () => {
      setupWebhookTarget({
        account: createMockAccount({
          dmPolicy: "disabled",
        }),
      });

      const payload = createTimestampedNewMessagePayloadForTest();

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });
  });

  describe("group message gating", () => {
    it("allows group messages when groupPolicy=open and no allowlist", async () => {
      setupWebhookTarget({
        account: createMockAccount({
          groupPolicy: "open",
        }),
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello from group",
        isGroup: true,
        chatGuid: "iMessage;+;chat123456",
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });

    it("blocks group messages when groupPolicy=disabled", async () => {
      setupWebhookTarget({
        account: createMockAccount({
          groupPolicy: "disabled",
        }),
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello from group",
        isGroup: true,
        chatGuid: "iMessage;+;chat123456",
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });

    it("treats chat_guid groups as group even when isGroup=false", async () => {
      setupWebhookTarget({
        account: createMockAccount({
          groupPolicy: "allowlist",
          dmPolicy: "open",
        }),
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello from group",
        chatGuid: "iMessage;+;chat123456",
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });

    it("allows group messages from allowed chat_guid in groupAllowFrom", async () => {
      setupWebhookTarget({
        account: createMockAccount({
          groupPolicy: "allowlist",
          groupAllowFrom: ["chat_guid:iMessage;+;chat123456"],
        }),
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello from allowed group",
        isGroup: true,
        chatGuid: "iMessage;+;chat123456",
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });
  });

  describe("mention gating (group messages)", () => {
    it("processes group message when mentioned and requireMention=true", async () => {
      mockResolveRequireMention.mockReturnValue(true);
      mockMatchesMentionPatterns.mockReturnValue(true);

      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "bert, can you help me?",
        isGroup: true,
        chatGuid: "iMessage;+;chat123456",
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = getFirstDispatchCall();
      expect(callArgs.ctx.WasMentioned).toBe(true);
    });

    it("skips group message when not mentioned and requireMention=true", async () => {
      mockResolveRequireMention.mockReturnValue(true);
      mockMatchesMentionPatterns.mockReturnValue(false);

      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello everyone",
        isGroup: true,
        chatGuid: "iMessage;+;chat123456",
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });

    it("processes group message without mention when requireMention=false", async () => {
      mockResolveRequireMention.mockReturnValue(false);

      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello everyone",
        isGroup: true,
        chatGuid: "iMessage;+;chat123456",
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });
  });

  describe("group metadata", () => {
    it("includes group subject + members in ctx", async () => {
      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello group",
        isGroup: true,
        chatGuid: "iMessage;+;chat123456",
        chatName: "Family",
        participants: [
          { address: "+15551234567", displayName: "Alice" },
          { address: "+15557654321", displayName: "Bob" },
        ],
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = getFirstDispatchCall();
      expect(callArgs.ctx.GroupSubject).toBe("Family");
      expect(callArgs.ctx.GroupMembers).toBe("Alice (+15551234567), Bob (+15557654321)");
    });

    it("does not enrich group participants when the config flag is disabled", async () => {
      const resolvePhoneNames = vi.fn(async () => new Map([["5551234567", "Alice Contact"]]));
      setupWebhookTarget({
        account: createMockAccount({
          enrichGroupParticipantsFromContacts: false,
        }),
      });
      setBlueBubblesParticipantContactDepsForTest({
        platform: "darwin",
        resolvePhoneNames,
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello bert",
        isGroup: true,
        chatGuid: "iMessage;+;chat123456",
        chatName: "Family",
        participants: [{ address: "+15551234567" }],
      });

      await dispatchWebhookPayload(payload);

      expect(resolvePhoneNames).not.toHaveBeenCalled();
      expect(getFirstDispatchCall().ctx.GroupMembers).toBe("+15551234567");
    });

    it("enriches unnamed phone participants from local contacts after gating passes", async () => {
      const resolvePhoneNames = vi.fn(
        async (phoneKeys: string[]) =>
          new Map(
            phoneKeys.map((phoneKey) => [
              phoneKey,
              phoneKey === "5551234567" ? "Alice Contact" : "Bob Contact",
            ]),
          ),
      );
      setupWebhookTarget({
        account: createMockAccount({
          enrichGroupParticipantsFromContacts: true,
        }),
      });
      setBlueBubblesParticipantContactDepsForTest({
        platform: "darwin",
        resolvePhoneNames,
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello bert",
        isGroup: true,
        chatGuid: "iMessage;+;chat123456",
        chatName: "Family",
        participants: [{ address: "+15551234567" }, { address: "+15557654321" }],
      });

      await dispatchWebhookPayload(payload);

      expect(resolvePhoneNames).toHaveBeenCalledTimes(1);
      const callArgs = getFirstDispatchCall();
      expect(callArgs.ctx.GroupMembers).toBe(
        "Alice Contact (+15551234567), Bob Contact (+15557654321)",
      );
    });

    it("fetches missing group participants from the BlueBubbles API before contact enrichment", async () => {
      const resolvePhoneNames = vi.fn(
        async (phoneKeys: string[]) =>
          new Map(
            phoneKeys.map((phoneKey) => [
              phoneKey,
              phoneKey === "5551234567" ? "Alice Contact" : "Bob Contact",
            ]),
          ),
      );
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                guid: "iMessage;+;chat123456",
                participants: [{ address: "+15551234567" }, { address: "+15557654321" }],
              },
            ],
          }),
      });
      setupWebhookTarget({
        account: createMockAccount({
          enrichGroupParticipantsFromContacts: true,
        }),
      });
      setBlueBubblesParticipantContactDepsForTest({
        platform: "darwin",
        resolvePhoneNames,
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello bert",
        isGroup: true,
        chatGuid: "iMessage;+;chat123456",
        chatName: "Family",
      });

      await dispatchWebhookPayload(payload);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/chat/query"),
        expect.objectContaining({ method: "POST" }),
      );
      expect(resolvePhoneNames).toHaveBeenCalledTimes(1);
      expect(getFirstDispatchCall().ctx.GroupMembers).toBe(
        "Alice Contact (+15551234567), Bob Contact (+15557654321)",
      );
    });

    it("does not read local contacts before mention gating allows the message", async () => {
      const resolvePhoneNames = vi.fn(async () => new Map([["5551234567", "Alice Contact"]]));
      setupWebhookTarget({
        account: createMockAccount({
          enrichGroupParticipantsFromContacts: true,
        }),
      });
      setBlueBubblesParticipantContactDepsForTest({
        platform: "darwin",
        resolvePhoneNames,
      });
      mockResolveRequireMention.mockReturnValueOnce(true);

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello group",
        isGroup: true,
        chatGuid: "iMessage;+;chat123456",
        chatName: "Family",
        participants: [{ address: "+15551234567" }],
      });

      await dispatchWebhookPayload(payload);

      expect(resolvePhoneNames).not.toHaveBeenCalled();
      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });
  });

  describe("group sender identity in envelope", () => {
    it("includes sender in envelope body and group label as from for group messages", async () => {
      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello everyone",
        senderName: "Alice",
        isGroup: true,
        chatGuid: "iMessage;+;chat123456",
        chatName: "Family Chat",
      });

      await dispatchWebhookPayload(payload);

      // formatInboundEnvelope should be called with group label + id as from, and sender info
      expect(mockFormatInboundEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "Family Chat id:iMessage;+;chat123456",
          chatType: "group",
          sender: { name: "Alice", id: "+15551234567" },
        }),
      );
      // ConversationLabel should be the group label + id, not the sender
      const callArgs = getFirstDispatchCall();
      expect(callArgs.ctx.ConversationLabel).toBe("Family Chat id:iMessage;+;chat123456");
      expect(callArgs.ctx.SenderName).toBe("Alice");
      // BodyForAgent should be raw text, not the envelope-formatted body
      expect(callArgs.ctx.BodyForAgent).toBe("hello everyone");
    });

    it("falls back to group:peerId when chatName is missing", async () => {
      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        isGroup: true,
        chatGuid: "iMessage;+;chat123456",
      });

      await dispatchWebhookPayload(payload);

      expect(mockFormatInboundEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({
          from: expect.stringMatching(/^Group id:/),
          chatType: "group",
          sender: { name: undefined, id: "+15551234567" },
        }),
      );
    });

    it("uses sender as from label for DM messages", async () => {
      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        senderName: "Alice",
      });

      await dispatchWebhookPayload(payload);

      expect(mockFormatInboundEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "Alice id:+15551234567",
          chatType: "direct",
          sender: { name: "Alice", id: "+15551234567" },
        }),
      );
      const callArgs = getFirstDispatchCall();
      expect(callArgs.ctx.ConversationLabel).toBe("Alice id:+15551234567");
    });
  });

  describe("inbound debouncing", () => {
    it("coalesces text-only then attachment webhook events by messageId", async () => {
      vi.useFakeTimers();
      try {
        const core = createMockRuntime();
        installTimingAwareInboundDebouncer(core);

        const _registration = trackWebhookRegistrationForTest(
          setupWebhookTargetForTest({
            createCore: createMockRuntime,
            core,
          }),
          (nextUnregister) => {
            unregister = nextUnregister;
          },
        );

        const messageId = "race-msg-1";
        const chatGuid = "iMessage;-;+15551234567";

        const payloadA = createTimestampedNewMessagePayloadForTest({
          guid: messageId,
          chatGuid,
        });

        const payloadB = createTimestampedNewMessagePayloadForTest({
          guid: messageId,
          chatGuid,
          attachments: [
            {
              guid: "att-1",
              mimeType: "image/jpeg",
              totalBytes: 1024,
            },
          ],
        });

        await dispatchWebhookPayloadDirect(payloadA);

        // Simulate the real-world delay where the attachment-bearing webhook arrives shortly after.
        await vi.advanceTimersByTimeAsync(300);

        await dispatchWebhookPayloadDirect(payloadB);

        // Not flushed yet; still within the debounce window.
        expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

        // After the debounce window, the combined message should be processed exactly once.
        await vi.advanceTimersByTimeAsync(600);

        expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
        const callArgs = getFirstDispatchCall();
        expect(callArgs.ctx.MediaPaths).toEqual(["/tmp/test-media.jpg"]);
        expect(callArgs.ctx.Body).toContain("hello");
      } finally {
        vi.useRealTimers();
      }
    });

    it("coalesces URL text with URL balloon webhook events by associatedMessageGuid", async () => {
      vi.useFakeTimers();
      try {
        const core = createMockRuntime();
        installTimingAwareInboundDebouncer(core);
        const processMessage = vi.fn().mockResolvedValue(undefined);
        const registry = createBlueBubblesDebounceRegistry({ processMessage });
        const account = createMockAccount();
        const target = {
          account,
          config: {},
          runtime: { log: vi.fn(), error: vi.fn() },
          core,
          path: "/bluebubbles-webhook",
        };
        const debouncer = registry.getOrCreateDebouncer(target);

        const messageId = "url-msg-1";
        const chatGuid = "iMessage;-;+15551234567";
        const url = "https://github.com/bitfocus/companion/issues/4047";

        await debouncer.enqueue({
          message: createDebounceTestMessage({
            chatGuid,
            text: url,
            messageId,
          }),
          target,
        });

        await vi.advanceTimersByTimeAsync(300);

        await debouncer.enqueue({
          message: createDebounceTestMessage({
            chatGuid,
            text: url,
            messageId: "url-balloon-1",
            balloonBundleId: "com.apple.messages.URLBalloonProvider",
            associatedMessageGuid: messageId,
          }),
          target,
        });

        expect(processMessage).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(600);

        expect(processMessage).toHaveBeenCalledTimes(1);
        expect(processMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            text: url,
            messageId,
            balloonBundleId: undefined,
          }),
          target,
        );
        expect(target.runtime.error).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("skips null-text entries during flush and still delivers the valid message", async () => {
      vi.useFakeTimers();
      try {
        const core = createMockRuntime();
        installTimingAwareInboundDebouncer(core);

        const processMessage = vi.fn().mockResolvedValue(undefined);
        const registry = createBlueBubblesDebounceRegistry({ processMessage });
        const account = createMockAccount();
        const target = {
          account,
          config: {},
          runtime: { log: vi.fn(), error: vi.fn() },
          core,
          path: "/bluebubbles-webhook",
        };
        const debouncer = registry.getOrCreateDebouncer(target);

        await debouncer.enqueue({
          message: {
            ...createDebounceTestMessage({
              messageId: "msg-null",
              chatGuid: "iMessage;-;+15551234567",
            }),
            text: null,
          } as unknown as NormalizedWebhookMessage,
          target,
        });

        await vi.advanceTimersByTimeAsync(300);

        await debouncer.enqueue({
          message: createDebounceTestMessage({
            text: "hello from valid entry",
            messageId: "msg-null",
            chatGuid: "iMessage;-;+15551234567",
          }),
          target,
        });

        await vi.advanceTimersByTimeAsync(600);

        expect(processMessage).toHaveBeenCalledTimes(1);
        expect(processMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            text: "hello from valid entry",
          }),
          target,
        );
        expect(target.runtime.error).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("reply metadata", () => {
    it("surfaces reply fields in ctx when provided", async () => {
      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "replying now",
        chatGuid: "iMessage;-;+15551234567",
        replyTo: {
          guid: "msg-0",
          text: "original message",
          handle: { address: "+15550000000", displayName: "Alice" },
        },
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = getFirstDispatchCall();
      // ReplyToId is the full UUID since it wasn't previously cached
      expect(callArgs.ctx.ReplyToId).toBe("msg-0");
      expect(callArgs.ctx.ReplyToBody).toBe("original message");
      expect(callArgs.ctx.ReplyToSender).toBe("+15550000000");
      // Body uses inline [[reply_to:N]] tag format
      expect(callArgs.ctx.Body).toContain("[[reply_to:msg-0]]");
    });

    it("drops group reply context from non-allowlisted senders in allowlist mode", async () => {
      setupWebhookTarget({
        account: createMockAccount({
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15551234567"],
        }),
        config: {
          channels: {
            bluebubbles: {
              contextVisibility: "allowlist",
            },
          },
        } as OpenClawConfig,
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "replying now",
        isGroup: true,
        chatGuid: "iMessage;+;chat-reply-visibility",
        replyTo: {
          guid: "msg-0",
          text: "blocked context",
          handle: { address: "+15550000000", displayName: "Alice" },
        },
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = getFirstDispatchCall();
      expect(callArgs.ctx.ReplyToId).toBeUndefined();
      expect(callArgs.ctx.ReplyToIdFull).toBeUndefined();
      expect(callArgs.ctx.ReplyToBody).toBeUndefined();
      expect(callArgs.ctx.ReplyToSender).toBeUndefined();
      expect(callArgs.ctx.Body).not.toContain("[[reply_to:");
    });

    it("keeps group reply context in allowlist_quote mode", async () => {
      setupWebhookTarget({
        account: createMockAccount({
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15551234567"],
        }),
        config: {
          channels: {
            bluebubbles: {
              contextVisibility: "allowlist_quote",
            },
          },
        } as OpenClawConfig,
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "replying now",
        isGroup: true,
        chatGuid: "iMessage;+;chat-reply-visibility",
        replyTo: {
          guid: "msg-0",
          text: "quoted context",
          handle: { address: "+15550000000", displayName: "Alice" },
        },
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = getFirstDispatchCall();
      expect(callArgs.ctx.ReplyToId).toBe("msg-0");
      expect(callArgs.ctx.ReplyToBody).toBe("quoted context");
      expect(callArgs.ctx.ReplyToSender).toBe("+15550000000");
      expect(callArgs.ctx.Body).toContain("[[reply_to:msg-0]]");
    });

    it("preserves part index prefixes in reply tags when short IDs are unavailable", async () => {
      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "replying now",
        chatGuid: "iMessage;-;+15551234567",
        replyTo: {
          guid: "p:1/msg-0",
          text: "original message",
          handle: { address: "+15550000000", displayName: "Alice" },
        },
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = getFirstDispatchCall();
      expect(callArgs.ctx.ReplyToId).toBe("p:1/msg-0");
      expect(callArgs.ctx.ReplyToIdFull).toBe("p:1/msg-0");
      expect(callArgs.ctx.Body).toContain("[[reply_to:p:1/msg-0]]");
    });

    it("hydrates missing reply sender/body from the recent-message cache", async () => {
      setupWebhookTarget();

      const chatGuid = "iMessage;+;chat-reply-cache";

      const originalPayload = createTimestampedNewMessagePayloadForTest({
        text: "original message (cached)",
        handle: { address: "+15550000000" },
        isGroup: true,
        guid: "cache-msg-0",
        chatGuid,
      });

      await dispatchWebhookPayload(originalPayload);

      // Only assert the reply message behavior below.
      mockDispatchReplyWithBufferedBlockDispatcher.mockClear();

      const replyPayload = createTimestampedNewMessagePayloadForTest({
        text: "replying now",
        isGroup: true,
        guid: "cache-msg-1",
        chatGuid,
        // Only the GUID is provided; sender/body must be hydrated.
        replyToMessageGuid: "cache-msg-0",
      });

      await dispatchWebhookPayload(replyPayload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = getFirstDispatchCall();
      // ReplyToId uses short ID "1" (first cached message) for token savings
      expect(callArgs.ctx.ReplyToId).toBe("1");
      expect(callArgs.ctx.ReplyToIdFull).toBe("cache-msg-0");
      expect(callArgs.ctx.ReplyToBody).toBe("original message (cached)");
      expect(callArgs.ctx.ReplyToSender).toBe("+15550000000");
      // Body uses inline [[reply_to:N]] tag format with short ID
      expect(callArgs.ctx.Body).toContain("[[reply_to:1]]");
    });

    it("falls back to threadOriginatorGuid when reply metadata is absent", async () => {
      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "replying now",
        threadOriginatorGuid: "msg-0",
        chatGuid: "iMessage;-;+15551234567",
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = getFirstDispatchCall();
      expect(callArgs.ctx.ReplyToId).toBe("msg-0");
    });
  });

  describe("tapback text parsing", () => {
    it("does not rewrite tapback-like text without metadata", async () => {
      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "Loved this idea",
        chatGuid: "iMessage;-;+15551234567",
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = getFirstDispatchCall();
      expect(callArgs.ctx.RawBody).toBe("Loved this idea");
      expect(callArgs.ctx.Body).toContain("Loved this idea");
      expect(callArgs.ctx.Body).not.toContain("reacted with");
    });

    it("parses tapback text with custom emoji when metadata is present", async () => {
      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        text: 'Reacted 😅 to "nice one"',
        guid: "msg-2",
        chatGuid: "iMessage;-;+15551234567",
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = getFirstDispatchCall();
      expect(callArgs.ctx.RawBody).toBe("reacted with 😅");
      expect(callArgs.ctx.Body).toContain("reacted with 😅");
      expect(callArgs.ctx.Body).not.toContain("[[reply_to:");
    });
  });

  describe("ack reactions", () => {
    it("sends ack reaction when configured", async () => {
      const { sendBlueBubblesReaction } = await import("./reactions.js");
      vi.mocked(sendBlueBubblesReaction).mockClear();

      setupWebhookTarget({
        config: {
          messages: {
            ackReaction: "❤️",
            ackReactionScope: "direct",
          },
        },
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        chatGuid: "iMessage;-;+15551234567",
      });

      await dispatchWebhookPayload(payload);

      expect(sendBlueBubblesReaction).toHaveBeenCalledWith(
        expect.objectContaining({
          chatGuid: "iMessage;-;+15551234567",
          messageGuid: "msg-1",
          emoji: "❤️",
          opts: expect.objectContaining({ accountId: "default" }),
        }),
      );
    });
  });

  describe("command gating", () => {
    it("allows control command to bypass mention gating when authorized", async () => {
      mockResolveRequireMention.mockReturnValue(true);
      mockMatchesMentionPatterns.mockReturnValue(false); // Not mentioned
      mockHasControlCommand.mockReturnValue(true); // Has control command
      mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true); // Authorized

      setupWebhookTarget({
        account: createMockAccount({
          groupPolicy: "open",
          allowFrom: ["+15551234567"],
        }),
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "/status",
        isGroup: true,
        chatGuid: "iMessage;+;chat123456",
      });

      await dispatchWebhookPayload(payload);

      // Should process even without mention because it's an authorized control command
      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });

    it("blocks control command from unauthorized sender in group", async () => {
      mockHasControlCommand.mockReturnValue(true);
      mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(false);

      setupWebhookTarget({
        account: createMockAccount({
          groupPolicy: "open",
          allowFrom: [], // No one authorized
        }),
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "/status",
        handle: { address: "+15559999999" },
        isGroup: true,
        chatGuid: "iMessage;+;chat123456",
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });

    it("does not auto-authorize DM control commands in open mode without allowlists", async () => {
      mockHasControlCommand.mockReturnValue(true);

      setupWebhookTarget({
        account: createMockAccount({
          dmPolicy: "open",
          allowFrom: [],
        }),
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "/status",
        handle: { address: "+15559999999" },
        guid: "msg-dm-open-unauthorized",
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const latestDispatch =
        mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[
          mockDispatchReplyWithBufferedBlockDispatcher.mock.calls.length - 1
        ]?.[0];
      expect(latestDispatch?.ctx?.CommandAuthorized).toBe(false);
    });
  });

  describe("typing/read receipt toggles", () => {
    it("marks chat as read when sendReadReceipts=true (default)", async () => {
      const { markBlueBubblesChatRead } = await import("./chat.js");
      vi.mocked(markBlueBubblesChatRead).mockClear();

      setupWebhookTarget({
        account: createMockAccount({
          sendReadReceipts: true,
        }),
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        chatGuid: "iMessage;-;+15551234567",
      });

      await dispatchWebhookPayload(payload);

      expect(markBlueBubblesChatRead).toHaveBeenCalled();
    });

    it("does not mark chat as read when sendReadReceipts=false", async () => {
      const { markBlueBubblesChatRead } = await import("./chat.js");
      vi.mocked(markBlueBubblesChatRead).mockClear();

      setupWebhookTarget({
        account: createMockAccount({
          sendReadReceipts: false,
        }),
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        chatGuid: "iMessage;-;+15551234567",
      });

      await dispatchWebhookPayload(payload);

      expect(markBlueBubblesChatRead).not.toHaveBeenCalled();
    });

    it("sends typing indicator when processing message", async () => {
      const { sendBlueBubblesTyping } = await import("./chat.js");
      vi.mocked(sendBlueBubblesTyping).mockClear();

      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        chatGuid: "iMessage;-;+15551234567",
      });

      mockDispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.onReplyStart?.();
        return EMPTY_DISPATCH_RESULT;
      });

      await dispatchWebhookPayload(payload);

      // Should call typing start when reply flow triggers it.
      expect(sendBlueBubblesTyping).toHaveBeenCalledWith(
        expect.any(String),
        true,
        expect.any(Object),
      );
    });

    it("stops typing on idle", async () => {
      const { sendBlueBubblesTyping } = await import("./chat.js");
      vi.mocked(sendBlueBubblesTyping).mockClear();

      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        chatGuid: "iMessage;-;+15551234567",
      });

      mockDispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.onReplyStart?.();
        await params.dispatcherOptions.deliver({ text: "replying now" }, { kind: "final" });
        params.dispatcherOptions.onIdle?.();
        return EMPTY_DISPATCH_RESULT;
      });

      await dispatchWebhookPayload(payload);

      expect(sendBlueBubblesTyping).toHaveBeenCalledWith(
        expect.any(String),
        false,
        expect.any(Object),
      );
    });

    it("stops typing when no reply is sent", async () => {
      const { sendBlueBubblesTyping } = await import("./chat.js");
      vi.mocked(sendBlueBubblesTyping).mockClear();

      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        chatGuid: "iMessage;-;+15551234567",
      });

      mockDispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
        async () => EMPTY_DISPATCH_RESULT,
      );

      await dispatchWebhookPayload(payload);

      expect(sendBlueBubblesTyping).toHaveBeenCalledWith(
        expect.any(String),
        false,
        expect.any(Object),
      );
    });
  });

  describe("outbound message ids", () => {
    it("enqueues system event for outbound message id", async () => {
      mockEnqueueSystemEvent.mockClear();

      mockDispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.deliver({ text: "replying now" }, { kind: "final" });
        return EMPTY_DISPATCH_RESULT;
      });

      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        chatGuid: "iMessage;-;+15551234567",
      });

      await dispatchWebhookPayload(payload);

      // Outbound message ID uses short ID "2" (inbound msg-1 is "1", outbound msg-123 is "2")
      expect(mockEnqueueSystemEvent).toHaveBeenCalledWith(
        'Assistant sent "replying now" [message_id:2]',
        expect.objectContaining({
          sessionKey: "agent:main:main",
        }),
      );
    });

    it("falls back to from-me webhook when send response has no message id", async () => {
      mockEnqueueSystemEvent.mockClear();

      const { sendMessageBlueBubbles } = await import("./send.js");
      vi.mocked(sendMessageBlueBubbles).mockResolvedValueOnce({ messageId: "ok" });

      mockDispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.deliver({ text: "replying now" }, { kind: "final" });
        return EMPTY_DISPATCH_RESULT;
      });

      setupWebhookTarget();

      const inboundPayload = createTimestampedNewMessagePayloadForTest({
        chatGuid: "iMessage;-;+15551234567",
      });

      await dispatchWebhookPayload(inboundPayload);

      // Send response did not include a message id, so nothing should be enqueued yet.
      expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();

      const fromMePayload = createTimestampedNewMessagePayloadForTest({
        text: "replying now",
        handle: { address: "+15557654321" },
        isFromMe: true,
        guid: "msg-out-456",
        chatGuid: "iMessage;-;+15551234567",
      });

      await dispatchWebhookPayload(fromMePayload);

      expect(mockEnqueueSystemEvent).toHaveBeenCalledWith(
        'Assistant sent "replying now" [message_id:2]',
        expect.objectContaining({
          sessionKey: "agent:main:main",
        }),
      );
    });

    it("matches from-me fallback by chatIdentifier when chatGuid is missing", async () => {
      mockEnqueueSystemEvent.mockClear();

      const { sendMessageBlueBubbles } = await import("./send.js");
      vi.mocked(sendMessageBlueBubbles).mockResolvedValueOnce({ messageId: "ok" });

      mockDispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.deliver({ text: "replying now" }, { kind: "final" });
        return EMPTY_DISPATCH_RESULT;
      });

      setupWebhookTarget();

      const inboundPayload = createTimestampedNewMessagePayloadForTest({
        chatGuid: "iMessage;-;+15551234567",
      });

      await dispatchWebhookPayload(inboundPayload);

      expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();

      const fromMePayload = createTimestampedNewMessagePayloadForTest({
        text: "replying now",
        handle: { address: "+15557654321" },
        isFromMe: true,
        guid: "msg-out-789",
        chatIdentifier: "+15551234567",
      });

      await dispatchWebhookPayload(fromMePayload);

      expect(mockEnqueueSystemEvent).toHaveBeenCalledWith(
        'Assistant sent "replying now" [message_id:2]',
        expect.objectContaining({
          sessionKey: "agent:main:main",
        }),
      );
    });
  });

  describe("reaction events", () => {
    it("drops DM reactions when dmPolicy=pairing and allowFrom is empty", async () => {
      mockEnqueueSystemEvent.mockClear();

      setupWebhookTarget({
        account: createMockAccount({ dmPolicy: "pairing", allowFrom: [] }),
      });

      const payload = createTimestampedMessageReactionPayloadForTest();

      await dispatchWebhookPayload(payload);

      expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
    });

    it("skips group reactions when requireMention=true", async () => {
      mockEnqueueSystemEvent.mockClear();
      mockResolveRequireMention.mockReturnValue(true);

      setupWebhookTarget({
        account: createMockAccount({
          groupPolicy: "open",
        }),
      });

      const payload = createTimestampedMessageReactionPayloadForTest({
        isGroup: true,
        chatGuid: "iMessage;+;chat123456",
        associatedMessageType: 2000,
        handle: { address: "+15559999999" },
      });

      await dispatchWebhookPayload(payload);

      expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
    });

    it("enqueues system event for reaction added", async () => {
      mockEnqueueSystemEvent.mockClear();

      setupWebhookTarget();

      const payload = createTimestampedMessageReactionPayloadForTest({
        associatedMessageType: 2000, // Heart reaction added
      });

      await dispatchWebhookPayload(payload);

      expect(mockEnqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("reacted with ❤️ [[reply_to:"),
        expect.any(Object),
      );
    });

    it("enqueues group reactions when requireMention=false", async () => {
      mockEnqueueSystemEvent.mockClear();
      mockResolveRequireMention.mockReturnValue(false);

      setupWebhookTarget({
        account: createMockAccount({
          groupPolicy: "open",
        }),
      });

      const payload = createTimestampedMessageReactionPayloadForTest({
        isGroup: true,
        chatGuid: "iMessage;+;chat123456",
        associatedMessageType: 2000,
        handle: { address: "+15559999999" },
      });

      await dispatchWebhookPayload(payload);

      expect(mockEnqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("reacted with ❤️ [[reply_to:"),
        expect.any(Object),
      );
    });

    it("enqueues system event for reaction removed", async () => {
      mockEnqueueSystemEvent.mockClear();

      setupWebhookTarget();

      const payload = createTimestampedMessageReactionPayloadForTest({
        associatedMessageType: 3000, // Heart reaction removed
      });

      await dispatchWebhookPayload(payload);

      expect(mockEnqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("removed ❤️ reaction [[reply_to:"),
        expect.any(Object),
      );
    });

    it("ignores reaction from self (fromMe=true)", async () => {
      mockEnqueueSystemEvent.mockClear();

      setupWebhookTarget();

      const payload = createTimestampedMessageReactionPayloadForTest({
        isFromMe: true, // From self
      });

      await dispatchWebhookPayload(payload);

      expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
    });

    it("maps reaction types to correct emojis", async () => {
      mockEnqueueSystemEvent.mockClear();

      setupWebhookTarget();

      // Test thumbs up reaction (2001)
      const payload = createTimestampedMessageReactionPayloadForTest({
        associatedMessageGuid: "msg-123",
        associatedMessageType: 2001, // Thumbs up
      });

      await dispatchWebhookPayload(payload);

      expect(mockEnqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("👍"),
        expect.any(Object),
      );
    });
  });

  describe("short message ID mapping", () => {
    it("assigns sequential short IDs to messages", async () => {
      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        guid: "p:1/msg-uuid-12345",
        chatGuid: "iMessage;-;+15551234567",
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = getFirstDispatchCall();
      // MessageSid should be short ID "1" instead of full UUID
      expect(callArgs.ctx.MessageSid).toBe("1");
      expect(callArgs.ctx.MessageSidFull).toBe("p:1/msg-uuid-12345");
    });

    it("resolves short ID back to UUID", async () => {
      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        guid: "p:1/msg-uuid-12345",
        chatGuid: "iMessage;-;+15551234567",
      });

      await dispatchWebhookPayload(payload);

      // The short ID "1" should resolve back to the full UUID
      expect(resolveBlueBubblesMessageId("1")).toBe("p:1/msg-uuid-12345");
    });

    it("returns UUID unchanged when not in cache", () => {
      expect(resolveBlueBubblesMessageId("msg-not-cached")).toBe("msg-not-cached");
    });

    it("returns short ID unchanged when numeric but not in cache", () => {
      expect(resolveBlueBubblesMessageId("999")).toBe("999");
    });

    it("throws when numeric short ID is missing and requireKnownShortId is set", () => {
      expect(() => resolveBlueBubblesMessageId("999", { requireKnownShortId: true })).toThrow(
        /short message id/i,
      );
    });
  });

  describe("history backfill", () => {
    it("scopes in-memory history by account to avoid cross-account leakage", async () => {
      mockFetchBlueBubblesHistory.mockImplementation(async (_chatIdentifier, _limit, opts) => {
        if (opts?.accountId === "acc-a") {
          return {
            resolved: true,
            entries: [
              { sender: "A", body: "a-history", messageId: "a-history-1", timestamp: 1000 },
            ],
          };
        }
        if (opts?.accountId === "acc-b") {
          return {
            resolved: true,
            entries: [
              { sender: "B", body: "b-history", messageId: "b-history-1", timestamp: 1000 },
            ],
          };
        }
        return { resolved: true, entries: [] };
      });

      const accountA: ResolvedBlueBubblesAccount = {
        ...createMockAccount({ dmHistoryLimit: 3, password: "password-a" }), // pragma: allowlist secret
        accountId: "acc-a",
      };
      const accountB: ResolvedBlueBubblesAccount = {
        ...createMockAccount({ dmHistoryLimit: 3, password: "password-b" }), // pragma: allowlist secret
        accountId: "acc-b",
      };
      const core = createMockRuntime();
      trackWebhookRegistrationForTest(
        setupWebhookTargetsForTest({
          createCore: createMockRuntime,
          core,
          accounts: [{ account: accountA }, { account: accountB }],
        }),
        (nextUnregister) => {
          unregister = nextUnregister;
        },
      );

      await dispatchWebhookPayload(
        createTimestampedNewMessagePayloadForTest({
          text: "message for account a",
          guid: "a-msg-1",
          chatGuid: "iMessage;-;+15551234567",
        }),
        "/bluebubbles-webhook?password=password-a",
      );

      await dispatchWebhookPayload(
        createTimestampedNewMessagePayloadForTest({
          text: "message for account b",
          guid: "b-msg-1",
          chatGuid: "iMessage;-;+15551234567",
        }),
        "/bluebubbles-webhook?password=password-b",
      );

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
      const firstCall = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
      const secondCall = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[1]?.[0];
      const firstHistory = (firstCall?.ctx.InboundHistory ?? []) as Array<{ body: string }>;
      const secondHistory = (secondCall?.ctx.InboundHistory ?? []) as Array<{ body: string }>;
      expect(firstHistory.map((entry) => entry.body)).toContain("a-history");
      expect(secondHistory.map((entry) => entry.body)).toContain("b-history");
      expect(secondHistory.map((entry) => entry.body)).not.toContain("a-history");
    });

    it("dedupes and caps merged history to dmHistoryLimit", async () => {
      mockFetchBlueBubblesHistory.mockResolvedValueOnce({
        resolved: true,
        entries: [
          { sender: "Friend", body: "older context", messageId: "hist-1", timestamp: 1000 },
          { sender: "Friend", body: "current text", messageId: "msg-1", timestamp: 2000 },
        ],
      });

      setupWebhookTarget({
        account: createMockAccount({ dmHistoryLimit: 2 }),
      });

      await dispatchWebhookPayload(
        createTimestampedNewMessagePayloadForTest({
          text: "current text",
          chatGuid: "iMessage;-;+15550002002",
        }),
      );

      const callArgs = getFirstDispatchCall();
      const inboundHistory = (callArgs.ctx.InboundHistory ?? []) as Array<{ body: string }>;
      expect(inboundHistory).toHaveLength(2);
      expect(inboundHistory.map((entry) => entry.body)).toEqual(["older context", "current text"]);
      expect(inboundHistory.filter((entry) => entry.body === "current text")).toHaveLength(1);
    });

    it("uses exponential backoff for unresolved backfill and stops after resolve", async () => {
      mockFetchBlueBubblesHistory
        .mockResolvedValueOnce({ resolved: false, entries: [] })
        .mockResolvedValueOnce({
          resolved: true,
          entries: [
            { sender: "Friend", body: "older context", messageId: "hist-1", timestamp: 1000 },
          ],
        });

      setupWebhookTarget({
        account: createMockAccount({ dmHistoryLimit: 4 }),
      });

      const mkPayload = (guid: string, text: string, now: number) =>
        createNewMessagePayloadForTest({
          text,
          guid,
          chatGuid: "iMessage;-;+15550003003",
          date: now,
        });

      let now = 1_700_000_000_000;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        await dispatchWebhookPayload(mkPayload("msg-1", "first text", now));
        expect(mockFetchBlueBubblesHistory).toHaveBeenCalledTimes(1);

        now += 1_000;
        await dispatchWebhookPayload(mkPayload("msg-2", "second text", now));
        expect(mockFetchBlueBubblesHistory).toHaveBeenCalledTimes(1);

        now += 6_000;
        await dispatchWebhookPayload(mkPayload("msg-3", "third text", now));
        expect(mockFetchBlueBubblesHistory).toHaveBeenCalledTimes(2);

        const thirdCall = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[2]?.[0];
        const thirdHistory = (thirdCall?.ctx.InboundHistory ?? []) as Array<{ body: string }>;
        expect(thirdHistory.map((entry) => entry.body)).toContain("older context");
        expect(thirdHistory.map((entry) => entry.body)).toContain("third text");

        now += 10_000;
        await dispatchWebhookPayload(mkPayload("msg-4", "fourth text", now));
        expect(mockFetchBlueBubblesHistory).toHaveBeenCalledTimes(2);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("caps inbound history payload size to reduce prompt-bomb risk", async () => {
      const huge = "x".repeat(8_000);
      mockFetchBlueBubblesHistory.mockResolvedValueOnce({
        resolved: true,
        entries: Array.from({ length: 20 }, (_, idx) => ({
          sender: `Friend ${idx}`,
          body: `${huge} ${idx}`,
          messageId: `hist-${idx}`,
          timestamp: idx + 1,
        })),
      });

      setupWebhookTarget({
        account: createMockAccount({ dmHistoryLimit: 20 }),
      });

      await dispatchWebhookPayload(
        createTimestampedNewMessagePayloadForTest({
          text: "latest text",
          guid: "msg-bomb-1",
          chatGuid: "iMessage;-;+15550004004",
        }),
      );

      const callArgs = getFirstDispatchCall();
      const inboundHistory = (callArgs.ctx.InboundHistory ?? []) as Array<{ body: string }>;
      const totalChars = inboundHistory.reduce((sum, entry) => sum + entry.body.length, 0);
      expect(inboundHistory.length).toBeLessThan(20);
      expect(totalChars).toBeLessThanOrEqual(12_000);
      expect(inboundHistory.every((entry) => entry.body.length <= 1_203)).toBe(true);
    });
  });

  describe("fromMe messages", () => {
    it("ignores messages from self (fromMe=true)", async () => {
      setupWebhookTarget();

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "my own message",
        isFromMe: true,
      });

      await dispatchWebhookPayload(payload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });

    it("drops reflected self-chat duplicates after a confirmed assistant outbound", async () => {
      setupWebhookTarget();

      const { sendMessageBlueBubbles } = await import("./send.js");
      vi.mocked(sendMessageBlueBubbles).mockResolvedValueOnce({ messageId: "msg-self-1" });

      mockDispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.deliver({ text: "replying now" }, { kind: "final" });
        return EMPTY_DISPATCH_RESULT;
      });

      const timestamp = Date.now();
      const inboundPayload = createNewMessagePayloadForTest({
        guid: "msg-self-0",
        chatGuid: "iMessage;-;+15551234567",
        date: timestamp,
      });

      await dispatchWebhookPayload(inboundPayload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
      mockDispatchReplyWithBufferedBlockDispatcher.mockClear();

      const fromMePayload = createNewMessagePayloadForTest({
        text: "replying now",
        isFromMe: true,
        guid: "msg-self-1",
        chatGuid: "iMessage;-;+15551234567",
        date: timestamp,
      });

      await dispatchWebhookPayload(fromMePayload);

      const reflectedPayload = createNewMessagePayloadForTest({
        text: "replying now",
        guid: "msg-self-2",
        chatGuid: "iMessage;-;+15551234567",
        date: timestamp,
      });

      await dispatchWebhookPayload(reflectedPayload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });

    it("does not drop inbound messages when no fromMe self-chat copy was seen", async () => {
      setupWebhookTarget();

      const inboundPayload = createTimestampedNewMessagePayloadForTest({
        text: "genuinely new message",
        guid: "msg-inbound-1",
        chatGuid: "iMessage;-;+15551234567",
      });

      await dispatchWebhookPayload(inboundPayload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });

    it("does not drop reflected copies after the self-chat cache TTL expires", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-07T00:00:00Z"));

      setupWebhookTarget();

      const timestamp = Date.now();
      const fromMePayload = createNewMessagePayloadForTest({
        text: "ttl me",
        isFromMe: true,
        guid: "msg-self-ttl-1",
        chatGuid: "iMessage;-;+15551234567",
        date: timestamp,
      });

      await dispatchWebhookPayloadDirect(fromMePayload);
      await vi.runAllTimersAsync();

      mockDispatchReplyWithBufferedBlockDispatcher.mockClear();
      vi.advanceTimersByTime(10_001);

      const reflectedPayload = createNewMessagePayloadForTest({
        text: "ttl me",
        guid: "msg-self-ttl-2",
        chatGuid: "iMessage;-;+15551234567",
        date: timestamp,
      });

      await dispatchWebhookPayloadDirect(reflectedPayload);
      await vi.runAllTimersAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });

    it("does not cache regular fromMe DMs as self-chat reflections", async () => {
      setupWebhookTarget();

      const timestamp = Date.now();
      const fromMePayload = createNewMessagePayloadForTest({
        text: "shared text",
        handle: { address: "+15557654321" },
        isFromMe: true,
        guid: "msg-normal-fromme",
        chatGuid: "iMessage;-;+15551234567",
        date: timestamp,
      });

      await dispatchWebhookPayload(fromMePayload);

      mockDispatchReplyWithBufferedBlockDispatcher.mockClear();

      const inboundPayload = createNewMessagePayloadForTest({
        text: "shared text",
        guid: "msg-normal-inbound",
        chatGuid: "iMessage;-;+15551234567",
        date: timestamp,
      });

      await dispatchWebhookPayload(inboundPayload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });

    it("does not drop user-authored self-chat prompts without a confirmed assistant outbound", async () => {
      setupWebhookTarget();

      const timestamp = Date.now();
      const fromMePayload = createNewMessagePayloadForTest({
        text: "user-authored self prompt",
        isFromMe: true,
        guid: "msg-self-user-1",
        chatGuid: "iMessage;-;+15551234567",
        date: timestamp,
      });

      await dispatchWebhookPayload(fromMePayload);

      mockDispatchReplyWithBufferedBlockDispatcher.mockClear();

      const reflectedPayload = createNewMessagePayloadForTest({
        text: "user-authored self prompt",
        guid: "msg-self-user-2",
        chatGuid: "iMessage;-;+15551234567",
        date: timestamp,
      });

      await dispatchWebhookPayload(reflectedPayload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });

    it("does not treat a pending text-only match as confirmed assistant outbound", async () => {
      setupWebhookTarget();

      const { sendMessageBlueBubbles } = await import("./send.js");
      vi.mocked(sendMessageBlueBubbles).mockResolvedValueOnce({ messageId: "ok" });

      mockDispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.deliver({ text: "same text" }, { kind: "final" });
        return EMPTY_DISPATCH_RESULT;
      });

      const timestamp = Date.now();
      const inboundPayload = createNewMessagePayloadForTest({
        guid: "msg-self-race-0",
        chatGuid: "iMessage;-;+15551234567",
        date: timestamp,
      });

      await dispatchWebhookPayload(inboundPayload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
      mockDispatchReplyWithBufferedBlockDispatcher.mockClear();

      const fromMePayload = createNewMessagePayloadForTest({
        text: "same text",
        isFromMe: true,
        guid: "msg-self-race-1",
        chatGuid: "iMessage;-;+15551234567",
        date: timestamp,
      });

      await dispatchWebhookPayload(fromMePayload);

      const reflectedPayload = createNewMessagePayloadForTest({
        text: "same text",
        guid: "msg-self-race-2",
        chatGuid: "iMessage;-;+15551234567",
        date: timestamp,
      });

      await dispatchWebhookPayload(reflectedPayload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });

    it("does not treat chatGuid-inferred sender ids as self-chat evidence", async () => {
      setupWebhookTarget();

      const timestamp = Date.now();
      const fromMePayload = createNewMessagePayloadForTest({
        text: "shared inferred text",
        handle: null,
        isFromMe: true,
        guid: "msg-inferred-fromme",
        chatGuid: "iMessage;-;+15551234567",
        date: timestamp,
      });

      await dispatchWebhookPayload(fromMePayload);

      mockDispatchReplyWithBufferedBlockDispatcher.mockClear();

      const inboundPayload = createNewMessagePayloadForTest({
        text: "shared inferred text",
        guid: "msg-inferred-inbound",
        chatGuid: "iMessage;-;+15551234567",
        date: timestamp,
      });

      await dispatchWebhookPayload(inboundPayload);

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });
  });
});
