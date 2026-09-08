import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readSessionSubmittedInput } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { writePreRegisteredChatAbort } from "./chat-abort-authorization.js";
import { resolveDurableChatClaim } from "./chat-restart-recovery.js";
import {
  resolveChatSendRequestConflict,
  respondChatSendRetry,
  runChatSendPreAdmission,
} from "./chat-send-pre-admission.js";
import { resolveChatSendStopOwnerScope } from "./chat-send-stop-owner-scope.js";

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  readSessionSubmittedInput: vi.fn(),
}));
vi.mock("./chat-restart-recovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-restart-recovery.js")>()),
  resolveDurableChatClaim: vi.fn(),
}));

type RetryParams = Parameters<typeof respondChatSendRetry>[0];

function retryFixture(runId: string) {
  const request: RetryParams["request"] = {
    rawMessage: "Hi @Bob",
    requestIdentity: "original-bob-selection",
    mentions: [{ profileId: "bob", start: 3, end: 7 }],
  };
  const session: RetryParams["session"] = {
    clientRunId: runId,
    pendingChatSendKey: pendingChatSendDedupeKey(runId),
    entry: { sessionId: "mention-session", updatedAt: 100 },
    agentId: "main",
    sessionKey: "agent:main:mentions",
    storePath: "/tmp/chat-retry-fixture.sqlite",
    restartSafeRequest: undefined,
  };
  return { request, session, context: createDirectChatContext(), respond: vi.fn() };
}

function expectConflict(respond: RetryParams["respond"]) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: "INVALID_REQUEST",
      details: { reason: "chat-request-conflict" },
    }),
  );
}

beforeEach(() => {
  vi.mocked(readSessionSubmittedInput).mockReset();
  vi.mocked(resolveDurableChatClaim).mockReset();
});

describe("chat send stop ownership", () => {
  it("keeps the selected filter separate from the compatibility run fallback", () => {
    const cfg: OpenClawConfig = {
      session: { scope: "global", store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    expect(
      resolveChatSendStopOwnerScope({
        cfg,
        selectedAgentId: "research",
        sessionKey: "global",
      }),
    ).toEqual({ agentId: "research", defaultAgentId: "ops" });
  });
});

describe("chat send retry identity", () => {
  it.each(["pending", "active", "queued", "terminal"] as const)(
    "rejects changed mention recipients before a %s acknowledgement",
    (state) => {
      const params = retryFixture(`changed-recipient-${state}`);
      const { clientRunId, pendingChatSendKey, sessionKey } = params.session;
      params.context.dedupe.set(state === "pending" ? pendingChatSendKey : `chat:${clientRunId}`, {
        ts: 100,
        ok: true,
        requestIdentity: params.request.requestIdentity,
        ...(state === "pending" || state === "terminal"
          ? {
              payload: {
                runId: clientRunId,
                sessionKey,
                status: state === "pending" ? "accepted" : "ok",
              },
            }
          : {}),
      });
      const controller = {
        controller: new AbortController(),
        sessionKey,
        sessionId: "mention-session",
      };
      if (state === "active") {
        params.context.chatAbortControllers.set(clientRunId, {
          ...controller,
          startedAtMs: 100,
          expiresAtMs: 200,
        });
      } else if (state === "queued") {
        params.context.chatQueuedTurns.set(clientRunId, controller);
      }
      expect(respondChatSendRetry(params)).toBe(true);
      expect(params.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          runId: clientRunId,
          status: state === "terminal" ? "ok" : "in_flight",
        }),
        undefined,
        expect.objectContaining({ cached: true }),
      );

      params.respond.mockClear();
      params.request.requestIdentity = "changed-carol-selection";
      params.request.mentions = [{ profileId: "carol", start: 3, end: 7 }];
      expect(respondChatSendRetry(params)).toBe(true);
      expectConflict(params.respond);
      expect(readSessionSubmittedInput).not.toHaveBeenCalled();
    },
  );

  it("keeps a transient preparation failure retryable without treating identity metadata as an ACK", () => {
    const params = retryFixture("metadata-only-retry");
    params.context.dedupe.set(`chat:${params.session.clientRunId}`, {
      ts: 100,
      ok: true,
      requestIdentity: params.request.requestIdentity,
    });
    expect(respondChatSendRetry(params)).toBe(false);
    expect(params.respond).not.toHaveBeenCalled();

    setGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      key: `chat:${params.session.clientRunId}`,
      entry: { ts: 200, ok: true, payload: { runId: params.session.clientRunId, status: "ok" } },
    });
    params.request.requestIdentity = "changed-after-terminal";
    expect(respondChatSendRetry(params)).toBe(true);
    expectConflict(params.respond);
  });

  it("transfers the pending input identity when an abort precedes active registration", () => {
    const params = retryFixture("early-abort-retry");
    params.context.dedupe.set(params.session.pendingChatSendKey, {
      ts: 100,
      ok: true,
      requestIdentity: params.request.requestIdentity,
      payload: {
        runId: params.session.clientRunId,
        status: "accepted",
        sessionKey: params.session.sessionKey,
        attemptId: "attempt",
      },
    });
    writePreRegisteredChatAbort({
      context: params.context,
      runId: params.session.clientRunId,
      stopReason: "rpc",
      attemptId: "attempt",
      endedAt: 200,
    });
    params.request.requestIdentity = "changed-after-abort";
    expect(respondChatSendRetry(params)).toBe(true);
    expectConflict(params.respond);
    expect(params.context.dedupe.has(params.session.pendingChatSendKey)).toBe(false);
  });

  it.each(["different", undefined])(
    "rejects a durable source retry with fingerprint %s",
    (fingerprint) => {
      const params = retryFixture(`durable-fingerprint-${fingerprint ?? "unavailable"}`);
      params.session.entry = {
        sessionId: "mention-session",
        updatedAt: 100,
        restartRecoveryDeliverySourceRunId: params.session.clientRunId,
        restartRecoveryDeliveryRequestFingerprint: "original",
      };
      params.session.restartSafeRequest = fingerprint ? { fingerprint } : undefined;
      expect(resolveChatSendRequestConflict(params)).toMatchObject({
        details: { reason: "chat-request-conflict" },
      });
      params.session.restartSafeRequest = { fingerprint: "original" };
      expect(resolveChatSendRequestConflict(params)).toBeUndefined();
      expect(readSessionSubmittedInput).not.toHaveBeenCalled();
    },
  );

  it.each(["unchanged", "removed", "replaced"] as const)(
    "compares %s selections to the original source after RAM identity expires",
    (selection) => {
      const params = retryFixture(`source-${selection}`);
      const original = {
        role: "user" as const,
        timestamp: 100,
        content: params.request.rawMessage,
        __openclaw: { humanMentions: params.request.mentions },
      };
      vi.mocked(readSessionSubmittedInput).mockReturnValue(original);
      params.context.dedupe.set(`chat:${params.session.clientRunId}`, {
        ts: 200,
        ok: true,
        payload: { runId: params.session.clientRunId, status: "ok" },
      });
      params.request.mentions =
        selection === "removed"
          ? undefined
          : selection === "replaced"
            ? [{ profileId: "carol", start: 3, end: 7 }]
            : params.request.mentions;
      expect(respondChatSendRetry(params)).toBe(true);
      if (selection === "unchanged") {
        expect(params.respond).toHaveBeenCalledWith(
          true,
          { runId: params.session.clientRunId, status: "ok" },
          undefined,
          { cached: true },
        );
      } else {
        expectConflict(params.respond);
      }
      expect(readSessionSubmittedInput).toHaveBeenCalledWith(
        {
          agentId: "main",
          sessionId: "mention-session",
          sessionKey: params.session.sessionKey,
          storePath: params.session.storePath,
        },
        `${params.session.clientRunId}:user`,
      );
    },
  );

  it.each(["missing", "redacted"] as const)(
    "does not acknowledge an unverifiable %s mention source",
    (source) => {
      const params = retryFixture(`unverifiable-${source}`);
      params.context.dedupe.set(`chat:${params.session.clientRunId}`, {
        ts: 200,
        ok: true,
        payload: { runId: params.session.clientRunId, status: "ok" },
      });
      if (source === "redacted") {
        vi.mocked(readSessionSubmittedInput).mockReturnValue({
          role: "user",
          timestamp: 100,
          content: "[REDACTED]",
        });
      }
      expect(respondChatSendRetry(params)).toBe(true);
      expectConflict(params.respond);
      if (source === "missing") {
        expect(params.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            message: expect.stringContaining("Check the conversation history"),
          }),
        );
      }
    },
  );

  it("rejects annotation removal from a terminal tombstone after the entire RAM cache is gone", () => {
    const params = retryFixture("terminal-source-without-cache");
    params.session.entry = {
      sessionId: "mention-session",
      updatedAt: 100,
      restartRecoveryTerminalRunIds: [params.session.clientRunId],
    };
    vi.mocked(readSessionSubmittedInput).mockReturnValue({
      role: "user",
      timestamp: 100,
      content: params.request.rawMessage,
      __openclaw: { humanMentions: params.request.mentions },
    });
    params.request.mentions = undefined;
    expect(resolveChatSendRequestConflict(params)).toMatchObject({
      details: { reason: "chat-request-conflict" },
    });
  });

  it("rechecks a competing request admitted while durable recovery yields", async () => {
    const fixture = retryFixture("recovery-race");
    const { session } = fixture;
    const deferred = createDeferred<Awaited<ReturnType<typeof resolveDurableChatClaim>>>();
    vi.mocked(resolveDurableChatClaim).mockReturnValue(deferred.promise);
    const params: Parameters<typeof runChatSendPreAdmission>[0] = {
      ...fixture,
      client: null,
      request: {
        ...fixture.request,
        p: {
          sessionKey: session.sessionKey,
          idempotencyKey: session.clientRunId,
          message: fixture.request.rawMessage,
        },
        chatSendReceivedAtMs: 100,
        supportsTaskSuggestions: false,
        inboundMessage: fixture.request.rawMessage,
        suppressCommandInterpretation: false,
        stopCommand: false,
        turnKind: "main",
        normalizedAttachments: [],
        reconnectResumeRequested: false,
      },
      session: {
        ...session,
        cfg: {},
        rawSessionKey: session.sessionKey,
        sessionLoadKey: session.sessionKey,
        sessionLoadOptions: { agentId: "main" },
        sessionLoadMs: 0,
        legacyKey: undefined,
        sessionRoutingChanged: () => false,
        expectedLeafEntryId: undefined,
        agentIdOverride: undefined,
        requestedAgentId: "main",
        selectedAgent: { ok: true, agentId: "main" },
        requestedSessionId: undefined,
        backingSessionId: "mention-session",
        activeRunScopeKey: session.sessionKey,
        resolvedSessionModel: { provider: "openai", model: "gpt-5.6-sol" },
        resolvedSessionAuthProvider: "openai",
        timeoutMs: 1000,
        now: 100,
      },
    };
    const pending = runChatSendPreAdmission(params);
    expect(resolveDurableChatClaim).toHaveBeenCalledOnce();
    fixture.context.dedupe.set(`chat:${session.clientRunId}`, {
      ts: 200,
      ok: true,
      requestIdentity: "competing-input",
      payload: { runId: session.clientRunId, status: "ok" },
    });
    deferred.resolve({ kind: "continue", entry: session.entry });
    expect(await pending).toBe(false);
    expectConflict(fixture.respond);
  });
});
