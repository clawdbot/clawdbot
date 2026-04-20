import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedBlueBubblesAccount } from "./accounts.js";
import { fetchBlueBubblesHistory } from "./history.js";
import {
  createHangingWebhookRequestForTest,
  createLoopbackWebhookRequestParamsForTest,
  createMockAccount,
  createPasswordQueryRequestParamsForTest,
  createProtectedWebhookAccountForTest,
  createRemoteWebhookRequestParamsForTest,
  createTimestampedNewMessagePayloadForTest,
  createWebhookDispatchForTest,
  dispatchWebhookPayloadForTest,
  expectWebhookRequestStatusForTest,
  expectWebhookStatusForTest,
  LOOPBACK_REMOTE_ADDRESSES_FOR_TEST,
  setupWebhookTargetForTest,
  setupWebhookTargetsForTest,
  trackWebhookRegistrationForTest,
  type WebhookRequestParams,
} from "./monitor.webhook.test-helpers.js";
import type { OpenClawConfig, PluginRuntime } from "./runtime-api.js";
import { createBlueBubblesFetchGuardPassthroughInstaller } from "./test-harness.js";
import {
  createBlueBubblesMonitorTestRuntime,
  EMPTY_DISPATCH_RESULT,
  resetBlueBubblesMonitorTestState,
  type DispatchReplyParams,
} from "./test-support/monitor-test-support.js";
import { _setFetchGuardForTesting } from "./types.js";

const { TEST_WEBHOOK_RATE_LIMIT_MAX_REQUESTS } = vi.hoisted(() => ({
  TEST_WEBHOOK_RATE_LIMIT_MAX_REQUESTS: 3,
}));
const TEST_WEBHOOK_BODY_TIMEOUT_MS = 1;

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

vi.mock("./reactions.js", () => ({
  normalizeBlueBubblesReactionInput: vi.fn((emoji: string, remove?: boolean) =>
    remove ? `-${emoji}` : emoji,
  ),
  sendBlueBubblesReaction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./history.js", () => ({
  fetchBlueBubblesHistory: vi.fn().mockResolvedValue({ entries: [], resolved: true }),
}));

vi.mock("./webhook-ingress.js", async () => {
  const actual =
    await vi.importActual<typeof import("./webhook-ingress.js")>("./webhook-ingress.js");
  return {
    ...actual,
    WEBHOOK_RATE_LIMIT_DEFAULTS: {
      ...actual.WEBHOOK_RATE_LIMIT_DEFAULTS,
      maxRequests: TEST_WEBHOOK_RATE_LIMIT_MAX_REQUESTS,
    },
    readWebhookBodyOrReject: (params: Parameters<typeof actual.readWebhookBodyOrReject>[0]) =>
      actual.readWebhookBodyOrReject({
        ...params,
        timeoutMs: TEST_WEBHOOK_BODY_TIMEOUT_MS,
      }),
  };
});

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
const TEST_WEBHOOK_PASSWORD = "secret-token";

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

describe("BlueBubbles webhook monitor", () => {
  let unregister: () => void;
  const installFetchGuardPassthrough = createBlueBubblesFetchGuardPassthroughInstaller();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    // See monitor.test.ts for rationale — BlueBubblesClient routes every BB
    // API call through the SSRF guard now. (#34749, #59722)
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
    });
  });

  afterEach(() => {
    unregister?.();
    vi.unstubAllGlobals();
    _setFetchGuardForTesting(null);
  });

  function setupWebhookTarget(params?: {
    account?: ResolvedBlueBubblesAccount;
    config?: OpenClawConfig;
    core?: PluginRuntime;
    statusSink?: (event: unknown) => void;
  }) {
    const registration = trackWebhookRegistrationForTest(
      setupWebhookTargetForTest({
        createCore: createMockRuntime,
        core: params?.core,
        account: params?.account,
        config: params?.config,
        statusSink: params?.statusSink,
      }),
      (nextUnregister) => {
        unregister = nextUnregister;
      },
    );
    return {
      account: registration.account,
      config: registration.config,
      core: registration.core,
    };
  }

  function setupProtectedWebhookTarget(password = TEST_WEBHOOK_PASSWORD) {
    return setupWebhookTargetAccount(createProtectedWebhookTarget(password).account);
  }

  function setupPasswordlessWebhookTarget() {
    return setupWebhookTargetAccount(createPasswordlessWebhookTarget().account);
  }

  function setupWebhookTargetAccount(account: ResolvedBlueBubblesAccount) {
    setupWebhookTarget({ account });
    return account;
  }

  function createWebhookTarget(
    account: ResolvedBlueBubblesAccount,
    statusSink: (event: unknown) => void = vi.fn(),
  ) {
    return { account, statusSink };
  }

  function createProtectedWebhookTarget(password = TEST_WEBHOOK_PASSWORD) {
    return createWebhookTarget(createProtectedWebhookAccountForTest(password));
  }

  function createPasswordlessWebhookTarget() {
    return createWebhookTarget(createMockAccount({ password: undefined }));
  }

  function createProtectedPasswordQueryRequestParams(password = TEST_WEBHOOK_PASSWORD) {
    return createPasswordQueryRequestParamsForTest({ password });
  }

  async function expectWebhookRequestStatusWithSetup(
    setup: () => void,
    params: WebhookRequestParams,
    expectedStatus: number,
    expectedBody?: string,
  ) {
    setup();
    return expectWebhookRequestStatusForTest(params, expectedStatus, expectedBody);
  }

  async function dispatchWebhookPayloadWithSetup(setup: () => void, payload: unknown) {
    setup();
    return dispatchWebhookPayloadForTest({ body: payload });
  }

  async function expectProtectedPasswordQueryRequestStatus(
    expectedStatus: number,
    password = TEST_WEBHOOK_PASSWORD,
  ) {
    return expectWebhookRequestStatusForTest(
      createProtectedPasswordQueryRequestParams(password),
      expectedStatus,
    );
  }

  async function expectProtectedWebhookRequestStatus(
    params: WebhookRequestParams,
    expectedStatus: number,
    expectedBody?: string,
  ) {
    return expectWebhookRequestStatusWithSetup(
      () => {
        setupProtectedWebhookTarget();
      },
      params,
      expectedStatus,
      expectedBody,
    );
  }

  async function expectRegisteredWebhookRequestStatus(
    params: WebhookRequestParams,
    expectedStatus: number,
    expectedBody?: string,
  ) {
    return expectWebhookRequestStatusWithSetup(
      () => {
        setupWebhookTarget();
      },
      params,
      expectedStatus,
      expectedBody,
    );
  }

  async function dispatchRegisteredWebhookPayload(payload: unknown) {
    return dispatchWebhookPayloadWithSetup(() => {
      setupWebhookTarget();
    }, payload);
  }

  async function expectLoopbackWebhookRequestStatus(
    remoteAddress: (typeof LOOPBACK_REMOTE_ADDRESSES_FOR_TEST)[number],
    expectedStatus: number,
    overrides?: Omit<WebhookRequestParams, "remoteAddress">,
  ) {
    return expectWebhookRequestStatusForTest(
      createLoopbackWebhookRequestParamsForTest(remoteAddress, { overrides }),
      expectedStatus,
    );
  }

  async function expectProtectedLoopbackWebhookRequestStatus(
    remoteAddress: (typeof LOOPBACK_REMOTE_ADDRESSES_FOR_TEST)[number],
    expectedStatus: number,
    overrides?: Omit<WebhookRequestParams, "remoteAddress">,
  ) {
    setupProtectedWebhookTarget();
    return expectLoopbackWebhookRequestStatus(remoteAddress, expectedStatus, overrides);
  }

  async function expectPasswordlessLoopbackWebhookRequestStatus(
    remoteAddress: (typeof LOOPBACK_REMOTE_ADDRESSES_FOR_TEST)[number],
    expectedStatus: number,
    overrides?: Omit<WebhookRequestParams, "remoteAddress">,
  ) {
    setupPasswordlessWebhookTarget();
    return expectLoopbackWebhookRequestStatus(remoteAddress, expectedStatus, overrides);
  }

  function registerWebhookTargets(
    params: Array<{
      account: ResolvedBlueBubblesAccount;
      statusSink?: (event: unknown) => void;
    }>,
  ) {
    trackWebhookRegistrationForTest(
      setupWebhookTargetsForTest({
        createCore: createMockRuntime,
        accounts: params,
      }),
      (nextUnregister) => {
        unregister = nextUnregister;
      },
    );
  }

  describe("webhook parsing + auth handling", () => {
    it("rejects non-POST requests", async () => {
      await expectRegisteredWebhookRequestStatus({ method: "GET" }, 405);
    });

    it("accepts POST requests with valid JSON payload", async () => {
      const payload = createTimestampedNewMessagePayloadForTest();
      await expectRegisteredWebhookRequestStatus({ body: payload }, 200, "ok");
    });

    it("rejects requests with invalid JSON", async () => {
      await expectRegisteredWebhookRequestStatus({ body: "invalid json {{" }, 400);
    });

    it("accepts URL-encoded payload wrappers", async () => {
      const payload = createTimestampedNewMessagePayloadForTest();
      const encodedBody = new URLSearchParams({
        payload: JSON.stringify(payload),
      }).toString();
      await expectRegisteredWebhookRequestStatus({ body: encodedBody }, 200, "ok");
    });

    it("returns 408 when request body times out (Slow-Loris protection)", async () => {
      setupWebhookTarget();

      // Create a request that never sends data or ends (simulates slow-loris).
      const { req, destroyMock } = createHangingWebhookRequestForTest();

      const { res, handledPromise } = createWebhookDispatchForTest(req);

      const handled = await handledPromise;
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(408);
      expect(destroyMock).toHaveBeenCalled();
    });

    it("rejects unauthorized requests before reading the body", async () => {
      setupProtectedWebhookTarget();
      const { req } = createHangingWebhookRequestForTest(
        "/bluebubbles-webhook?password=wrong-token",
      );
      const onSpy = vi.spyOn(req, "on");
      await expectWebhookStatusForTest(req, 401);
      expect(onSpy).not.toHaveBeenCalledWith("data", expect.any(Function));
    });

    it("authenticates via password query parameter", async () => {
      await expectProtectedWebhookRequestStatus(createProtectedPasswordQueryRequestParams(), 200);
    });

    it("authenticates via x-password header", async () => {
      await expectProtectedWebhookRequestStatus(
        createRemoteWebhookRequestParamsForTest({
          overrides: {
            headers: { "x-password": TEST_WEBHOOK_PASSWORD }, // pragma: allowlist secret
          },
        }),
        200,
      );
    });

    it("rejects unauthorized requests with wrong password", async () => {
      await expectProtectedWebhookRequestStatus(
        createProtectedPasswordQueryRequestParams("wrong-token"),
        401,
      );
    });

    it("rate limits repeated invalid password guesses from the same client", async () => {
      setupWebhookTarget({
        account: createMockAccount({
          password: "99999999",
        }),
      });

      let saw429 = false;
      for (let i = 0; i < TEST_WEBHOOK_RATE_LIMIT_MAX_REQUESTS + 4; i += 1) {
        const candidate = String(i).padStart(8, "0");
        const { res } = await dispatchWebhookPayloadForTest(
          createPasswordQueryRequestParamsForTest({
            password: candidate,
            body: createTimestampedNewMessagePayloadForTest({
              guid: `msg-${i}`,
              text: `hello ${i}`,
            }),
            remoteAddress: "192.168.1.100",
          }),
        );

        if (res.statusCode === 429) {
          saw429 = true;
          break;
        }

        expect(res.statusCode).toBe(401);
      }

      expect(saw429).toBe(true);
      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });

    it("keeps forwarded clients behind configured trusted proxies in separate auth buckets", async () => {
      setupWebhookTarget({
        account: createMockAccount({
          password: "99999999",
        }),
        config: {
          gateway: {
            trustedProxies: ["10.0.0.0/8"],
          },
        } as OpenClawConfig,
      });

      let saw429 = false;
      for (let i = 0; i < TEST_WEBHOOK_RATE_LIMIT_MAX_REQUESTS + 4; i += 1) {
        const candidate = String(i).padStart(8, "0");
        const { res } = await dispatchWebhookPayloadForTest(
          createPasswordQueryRequestParamsForTest({
            password: candidate,
            body: createTimestampedNewMessagePayloadForTest({
              guid: `proxy-msg-${i}`,
              text: `hello proxy ${i}`,
            }),
            remoteAddress: "10.0.0.5",
            overrides: {
              headers: {
                host: "localhost",
                "x-forwarded-for": "203.0.113.10",
              },
            },
          }),
        );

        if (res.statusCode === 429) {
          saw429 = true;
          break;
        }

        expect(res.statusCode).toBe(401);
      }

      expect(saw429).toBe(true);

      await expectWebhookRequestStatusForTest(
        createPasswordQueryRequestParamsForTest({
          password: "wrong-pass",
          body: createTimestampedNewMessagePayloadForTest({
            guid: "proxy-msg-other-client",
            text: "hello other proxy client",
          }),
          remoteAddress: "10.0.0.5",
          overrides: {
            headers: {
              host: "localhost",
              "x-forwarded-for": "203.0.113.11",
            },
          },
        }),
        401,
      );
    });

    it("keeps real-ip fallback clients behind trusted proxies in separate auth buckets", async () => {
      setupWebhookTarget({
        account: createMockAccount({
          password: "99999999",
        }),
        config: {
          gateway: {
            trustedProxies: ["10.0.0.0/8"],
            allowRealIpFallback: true,
          },
        } as OpenClawConfig,
      });

      let saw429 = false;
      for (let i = 0; i < TEST_WEBHOOK_RATE_LIMIT_MAX_REQUESTS + 4; i += 1) {
        const candidate = String(i).padStart(8, "0");
        const { res } = await dispatchWebhookPayloadForTest(
          createPasswordQueryRequestParamsForTest({
            password: candidate,
            body: createTimestampedNewMessagePayloadForTest({
              guid: `real-ip-msg-${i}`,
              text: `hello real ip ${i}`,
            }),
            remoteAddress: "10.0.0.5",
            overrides: {
              headers: {
                host: "localhost",
                "x-real-ip": "203.0.113.10",
              },
            },
          }),
        );

        if (res.statusCode === 429) {
          saw429 = true;
          break;
        }

        expect(res.statusCode).toBe(401);
      }

      expect(saw429).toBe(true);

      await expectWebhookRequestStatusForTest(
        createPasswordQueryRequestParamsForTest({
          password: "wrong-pass",
          body: createTimestampedNewMessagePayloadForTest({
            guid: "real-ip-msg-other-client",
            text: "hello other real ip client",
          }),
          remoteAddress: "10.0.0.5",
          overrides: {
            headers: {
              host: "localhost",
              "x-real-ip": "203.0.113.11",
            },
          },
        }),
        401,
      );
    });

    it("rejects ambiguous routing when multiple targets match the same password", async () => {
      const targetA = createProtectedWebhookTarget();
      const targetB = createProtectedWebhookTarget();
      registerWebhookTargets([targetA, targetB]);

      await expectProtectedPasswordQueryRequestStatus(401);
      expect(targetA.statusSink).not.toHaveBeenCalled();
      expect(targetB.statusSink).not.toHaveBeenCalled();
    });

    it("ignores targets without passwords when a password-authenticated target matches", async () => {
      const strictTarget = createProtectedWebhookTarget();
      const passwordlessTarget = createPasswordlessWebhookTarget();
      registerWebhookTargets([strictTarget, passwordlessTarget]);

      await expectProtectedPasswordQueryRequestStatus(200);
      expect(strictTarget.statusSink).toHaveBeenCalledTimes(1);
      expect(passwordlessTarget.statusSink).not.toHaveBeenCalled();
    });

    it("requires authentication for loopback requests when password is configured", async () => {
      for (const remoteAddress of LOOPBACK_REMOTE_ADDRESSES_FOR_TEST) {
        await expectProtectedLoopbackWebhookRequestStatus(remoteAddress, 401);
      }
    });

    it("rejects targets without passwords for loopback and proxied-looking requests", async () => {
      const headerVariants: Record<string, string>[] = [
        { host: "localhost" },
        { host: "localhost", "x-forwarded-for": "203.0.113.10" },
        { host: "localhost", forwarded: "for=203.0.113.10;proto=https;host=example.com" },
      ];
      for (const headers of headerVariants) {
        await expectPasswordlessLoopbackWebhookRequestStatus("127.0.0.1", 401, { headers });
      }
    });

    it("ignores unregistered webhook paths", async () => {
      const { handled } = await dispatchWebhookPayloadForTest({
        url: "/unregistered-path",
      });

      expect(handled).toBe(false);
    });

    it("parses chatId when provided as a string (webhook variant)", async () => {
      const { resolveChatGuidForTarget } = await import("./send.js");
      vi.mocked(resolveChatGuidForTarget).mockClear();

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello from group",
        isGroup: true,
        chatId: "123",
      });

      await dispatchRegisteredWebhookPayload(payload);

      expect(resolveChatGuidForTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { kind: "chat_id", chatId: 123 },
        }),
      );
    });

    it("extracts chatGuid from nested chat object fields (webhook variant)", async () => {
      const { sendMessageBlueBubbles, resolveChatGuidForTarget } = await import("./send.js");
      vi.mocked(sendMessageBlueBubbles).mockClear();
      vi.mocked(resolveChatGuidForTarget).mockClear();

      mockDispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.deliver({ text: "replying now" }, { kind: "final" });
        return EMPTY_DISPATCH_RESULT;
      });

      const payload = createTimestampedNewMessagePayloadForTest({
        text: "hello from group",
        isGroup: true,
        chat: { chatGuid: "iMessage;+;chat123456" },
      });

      await dispatchRegisteredWebhookPayload(payload);

      expect(resolveChatGuidForTarget).not.toHaveBeenCalled();
      expect(sendMessageBlueBubbles).toHaveBeenCalledWith(
        "chat_guid:iMessage;+;chat123456",
        expect.any(String),
        expect.any(Object),
      );
    });
  });
});
