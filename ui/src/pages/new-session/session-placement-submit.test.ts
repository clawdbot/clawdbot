import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { sessionPlacementRecoveryExactStorageKey } from "../../lib/sessions/session-placement-recovery-storage-key.ts";
import {
  clearSessionPlacementRecovery,
  readSessionPlacementRecovery,
  type SessionPlacementPendingRecovery as SessionPlacementRecovery,
  writeSessionPlacementRecovery,
} from "../../lib/sessions/session-placement-recovery.ts";
import { advanceSessionPlacementDraft as advanceSessionPlacementDraftWithRecovery } from "../../lib/sessions/session-placement-submit.ts";

type AdvanceParams = Omit<
  Parameters<typeof advanceSessionPlacementDraftWithRecovery>[0],
  "cleanupOnCancellation" | "recovery"
> &
  Omit<SessionPlacementRecovery, "sessionKey" | "phase"> & {
    cleanupOnCancellation?: boolean;
    key: string;
    recoveryPhase: SessionPlacementRecovery["phase"];
  };

function advanceSessionPlacementDraft(params: AdvanceParams) {
  const {
    key,
    messageId,
    message,
    attachments,
    target,
    agentId,
    gatewayUrl,
    recoveryScope,
    recoveryPhase,
    ...options
  } = params;
  return advanceSessionPlacementDraftWithRecovery({
    ...options,
    cleanupOnCancellation: options.cleanupOnCancellation ?? true,
    recovery: {
      sessionKey: key,
      messageId,
      message,
      attachments,
      target,
      agentId,
      gatewayUrl,
      recoveryScope,
      phase: recoveryPhase,
    },
  });
}

function clientWith(request: ReturnType<typeof vi.fn>): Pick<GatewayBrowserClient, "request"> {
  return { request: request as GatewayBrowserClient["request"] };
}

const recoveryStorageKey = (sessionKey: string) =>
  sessionPlacementRecoveryExactStorageKey("ws://gateway.example", "principal-a", sessionKey);

describe("session placement draft advancement", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves a recovered session when recovery storage becomes unavailable", async () => {
    sessionStorage.setItem(
      recoveryStorageKey("agent:cloud:recovered"),
      JSON.stringify({
        sessionKey: "agent:cloud:recovered",
        messageId: "message-recovered",
        message: "resume remotely",
        target: { kind: "profile", profileId: "aws" },
        agentId: "cloud",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "sending",
      }),
    );
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => {
        throw new DOMException("storage disabled", "SecurityError");
      }),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    });
    const request = vi.fn().mockRejectedValue(new Error("history unavailable"));
    const clearRecovery = vi.fn();

    await expect(
      advanceSessionPlacementDraft({
        client: clientWith(request),
        key: "agent:cloud:recovered",
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws" },
        message: "resume remotely",
        messageId: "message-recovered",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        recoveryPhase: "sending",
        recovering: true,
        isLifecycleCurrent: () => true,
        ownsRecovery: () => true,
        clearRecovery,
        setRecoveryPhase: vi.fn(),
      }),
    ).resolves.toMatchObject({
      status: "paused",
      recovery: {
        reason: "unconfirmed",
        message: "resume remotely",
        error: expect.stringContaining("Keep this page open"),
      },
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.history"]);
    expect(clearRecovery).not.toHaveBeenCalled();
  });

  it("sends an older startup in memory without replacing a newer durable session", async () => {
    const gatewayUrl = "ws://gateway.example";
    const recoveryScope = "principal-a";
    const sessionKey = "agent:cloud:older";
    const newerRecovery: SessionPlacementRecovery = {
      sessionKey: "agent:cloud:newer",
      messageId: "message-newer",
      message: "newer task",
      target: { kind: "profile", profileId: "aws" },
      agentId: "cloud",
      gatewayUrl,
      recoveryScope,
      phase: "dispatching",
    };
    const request = vi.fn((method: string) => {
      if (method === "sessions.dispatch") {
        expect(writeSessionPlacementRecovery(newerRecovery)).toBe(true);
        return Promise.resolve({ placement: { state: "active", environmentId: "worker-older" } });
      }
      if (method === "sessions.send") {
        return Promise.resolve({ runId: "run-older", status: "started" });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const setRecoveryPhase = vi.fn();
    const clearRecovery = vi.fn(() =>
      clearSessionPlacementRecovery(gatewayUrl, recoveryScope, sessionKey),
    );

    await expect(
      advanceSessionPlacementDraft({
        client: clientWith(request),
        key: sessionKey,
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws" },
        message: "older task",
        messageId: "message-older",
        gatewayUrl,
        recoveryScope,
        recoveryPhase: "dispatching",
        recovering: false,
        isLifecycleCurrent: () => true,
        ownsRecovery: () => true,
        clearRecovery,
        setRecoveryPhase,
      }),
    ).resolves.toMatchObject({ status: "started", messageId: "message-older" });
    expect(setRecoveryPhase).toHaveBeenCalledWith("sending", true);
    expect(
      readSessionPlacementRecovery(gatewayUrl, recoveryScope, newerRecovery.sessionKey),
    ).toEqual(newerRecovery);
    expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "sessions.delete")).toHaveLength(0);
    expect(clearRecovery).toHaveBeenCalledWith("resolved");
  });

  it("fails closed when the current durable owner cannot persist sending", async () => {
    const storage = sessionStorage;
    const request = vi.fn((method: string) => {
      if (method === "sessions.dispatch") {
        vi.stubGlobal("sessionStorage", {
          getItem: storage.getItem.bind(storage),
          removeItem: storage.removeItem.bind(storage),
          setItem: vi.fn(() => {
            throw new DOMException("storage disabled", "SecurityError");
          }),
        });
        return Promise.resolve({
          placement: { state: "active", environmentId: "worker-current" },
        });
      }
      if (method === "sessions.reclaim") {
        return Promise.resolve({ ok: true });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const setRecoveryPhase = vi.fn();

    await expect(
      advanceSessionPlacementDraft({
        client: clientWith(request),
        key: "agent:cloud:current",
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws" },
        message: "current task",
        messageId: "message-current",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        recoveryPhase: "dispatching",
        recovering: false,
        isLifecycleCurrent: () => true,
        ownsRecovery: () => true,
        clearRecovery: vi.fn(),
        setRecoveryPhase,
      }),
    ).resolves.toMatchObject({
      status: "paused",
      recovery: {
        reason: "not-sent",
        message: "current task",
        error:
          "Recovery could not be saved in this tab. Keep this page open.\nplacement recovery storage is unavailable",
      },
    });
    expect(setRecoveryPhase).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("sessions.reclaim", {
      key: "agent:cloud:current",
      agentId: "cloud",
    });
    expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(0);
  });

  it("does not overwrite recovery after submission ownership is lost", async () => {
    sessionStorage.setItem(
      recoveryStorageKey("agent:cloud:newer"),
      JSON.stringify({
        sessionKey: "agent:cloud:newer",
        messageId: "message-newer",
        message: "newer task",
        target: { kind: "profile", profileId: "aws" },
        agentId: "cloud",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "dispatching",
      }),
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce({ session: { sessionId: "session-stale" } })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, deleted: true });
    const clearRecovery = vi.fn();

    await expect(
      advanceSessionPlacementDraft({
        client: clientWith(request),
        key: "agent:cloud:stale",
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws" },
        message: "stale task",
        messageId: "message-stale",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        recoveryPhase: "dispatching",
        recovering: false,
        isLifecycleCurrent: () => false,
        ownsRecovery: () => false,
        clearRecovery,
        setRecoveryPhase: vi.fn(),
      }),
    ).resolves.toEqual({ status: "cancelled", recoveryPersisted: false });
    expect(
      JSON.parse(sessionStorage.getItem(recoveryStorageKey("agent:cloud:newer")) ?? "null"),
    ).toMatchObject({ sessionKey: "agent:cloud:newer" });
    expect(clearRecovery).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "the page is interrupted after accepted delivery",
      lifecycleCurrent: false,
      recoveryOwned: true,
      status: "interrupted",
      retirement: "interrupted",
    },
    {
      name: "a newer owner takes over",
      lifecycleCurrent: true,
      recoveryOwned: false,
      status: "ownership-lost",
      retirement: "resolved",
    },
  ] as const)("retires only the completed submission when $name", async (testCase) => {
    const { lifecycleCurrent, recoveryOwned, retirement, status } = testCase;
    const gatewayUrl = "ws://gateway.example";
    const recoveryScope = "principal-a";
    const sessionKey = "agent:cloud:stale";
    const newerRecovery = {
      sessionKey: "agent:cloud:newer",
      messageId: "message-newer",
      message: "newer task",
      target: { kind: "profile", profileId: "aws" },
      agentId: "cloud",
      gatewayUrl,
      recoveryScope,
      phase: "dispatching" as const,
    } satisfies SessionPlacementRecovery;
    const request = vi
      .fn()
      .mockResolvedValueOnce({ placement: { state: "active", environmentId: "environment-1" } })
      .mockImplementationOnce(async () => {
        if (!recoveryOwned) {
          expect(writeSessionPlacementRecovery(newerRecovery)).toBe(true);
        }
        return { runId: "run-stale", status: "started" };
      });
    // Both fences stay current through the helper's five safety checks. One
    // independent fact changes before the caller classifies accepted delivery.
    let lifecycleChecks = 0;
    let ownershipChecks = 0;
    const clearRecovery = vi.fn(() =>
      clearSessionPlacementRecovery(gatewayUrl, recoveryScope, sessionKey),
    );

    await expect(
      advanceSessionPlacementDraft({
        client: clientWith(request),
        key: sessionKey,
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws" },
        message: "interrupted task",
        messageId: "message-interrupted",
        gatewayUrl,
        recoveryScope,
        recoveryPhase: "dispatching",
        recovering: false,
        isLifecycleCurrent: () => {
          lifecycleChecks += 1;
          return lifecycleCurrent || lifecycleChecks < 6;
        },
        ownsRecovery: () => {
          ownershipChecks += 1;
          return recoveryOwned || ownershipChecks < 6;
        },
        clearRecovery,
        setRecoveryPhase: vi.fn(),
      }),
    ).resolves.toEqual({ status });
    expect(clearRecovery).toHaveBeenCalledWith(retirement);
    expect(
      readSessionPlacementRecovery(gatewayUrl, recoveryScope, newerRecovery.sessionKey),
    ).toEqual(recoveryOwned ? null : newerRecovery);
  });

  it("does not persist volatile incognito recovery when submission is cancelled", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ session: { sessionId: "session-incognito" } })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, deleted: true });

    await expect(
      advanceSessionPlacementDraft({
        client: clientWith(request),
        key: "agent:cloud:incognito",
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws" },
        message: "private task",
        messageId: "message-private",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        recoveryPhase: "dispatching",
        persistRecovery: false,
        recovering: false,
        isLifecycleCurrent: () => false,
        ownsRecovery: () => false,
        clearRecovery: vi.fn(),
        setRecoveryPhase: vi.fn(),
      }),
    ).resolves.toEqual({ status: "cancelled", recoveryPersisted: false });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "sessions.describe",
      "sessions.patch",
      "sessions.delete",
    ]);
    expect(sessionStorage.length).toBe(0);
  });

  it("keeps a cancelled draft recoverable when its cleanup fails", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ session: { sessionId: "session-cancelled" } })
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("delete unavailable"))
      .mockResolvedValueOnce({ ok: true });
    const clearRecovery = vi.fn();

    await expect(
      advanceSessionPlacementDraft({
        client: clientWith(request),
        key: "agent:cloud:cancelled",
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws" },
        message: "cancelled task",
        messageId: "message-cancelled",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        recoveryPhase: "dispatching",
        recovering: false,
        isLifecycleCurrent: () => false,
        ownsRecovery: () => false,
        clearRecovery,
        setRecoveryPhase: vi.fn(),
      }),
    ).resolves.toEqual({
      status: "cancelled",
      cleanupError: "delete unavailable",
      recoveryPersisted: true,
    });
    expect(
      JSON.parse(sessionStorage.getItem(recoveryStorageKey("agent:cloud:cancelled")) ?? "null"),
    ).toMatchObject({ sessionKey: "agent:cloud:cancelled" });
    expect(clearRecovery).not.toHaveBeenCalled();
    expect(request).toHaveBeenLastCalledWith("sessions.patch", {
      key: "agent:cloud:cancelled",
      agentId: "cloud",
      archived: false,
      expectedSessionId: "session-cancelled",
    });
  });

  it("pauses uncertain delivery without allocating after terminal placement", async () => {
    sessionStorage.setItem(
      recoveryStorageKey("agent:cloud:recovered"),
      JSON.stringify({
        sessionKey: "agent:cloud:recovered",
        messageId: "message-recovered",
        message: "possibly accepted task",
        target: { kind: "profile", profileId: "aws", machineClass: "fast" },
        agentId: "cloud",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "sending",
      }),
    );
    const request = vi.fn().mockResolvedValueOnce({ messages: [] });
    const clearRecovery = vi.fn();

    await expect(
      advanceSessionPlacementDraft({
        client: clientWith(request),
        key: "agent:cloud:recovered",
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws", machineClass: "fast" },
        message: "possibly accepted task",
        messageId: "message-recovered",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        recoveryPhase: "sending",
        recovering: true,
        isLifecycleCurrent: () => true,
        ownsRecovery: () => true,
        clearRecovery,
        setRecoveryPhase: vi.fn(),
      }),
    ).resolves.toMatchObject({
      status: "paused",
      recovery: {
        reason: "unconfirmed",
        messageId: "message-recovered",
        message: "possibly accepted task",
      },
    });
    expect(request).not.toHaveBeenCalledWith("sessions.dispatch", expect.anything());
    expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
    expect(request).not.toHaveBeenCalledWith("sessions.delete", expect.anything());
    expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.history"]);
    expect(clearRecovery).not.toHaveBeenCalled();
  });

  it("keeps the visible session after a definitive redispatch rejection", async () => {
    sessionStorage.setItem(
      recoveryStorageKey("agent:cloud:recovered"),
      JSON.stringify({
        sessionKey: "agent:cloud:recovered",
        messageId: "message-recovered",
        message: "retry this task",
        target: { kind: "profile", profileId: "aws" },
        agentId: "cloud",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "sending",
      }),
    );
    const request = vi.fn().mockRejectedValueOnce(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "cloud profile was removed",
        retryable: false,
      }),
    );
    const clearRecovery = vi.fn();

    await expect(
      advanceSessionPlacementDraft({
        client: clientWith(request),
        key: "agent:cloud:recovered",
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws" },
        message: "retry this task",
        messageId: "message-recovered",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        recoveryPhase: "dispatching",
        recovering: false,
        isLifecycleCurrent: () => true,
        ownsRecovery: () => true,
        clearRecovery,
        setRecoveryPhase: vi.fn(),
      }),
    ).resolves.toMatchObject({
      status: "paused",
      recovery: {
        reason: "not-sent",
        error: "cloud profile was removed",
        message: "retry this task",
      },
    });
    expect(request).not.toHaveBeenCalledWith("sessions.delete", expect.anything());
    expect(clearRecovery).not.toHaveBeenCalled();
  });

  it("clears recovery when its draft session no longer exists", async () => {
    sessionStorage.setItem(
      recoveryStorageKey("agent:cloud:missing"),
      JSON.stringify({
        sessionKey: "agent:cloud:missing",
        messageId: "message-missing",
        message: "missing task",
        target: { kind: "profile", profileId: "aws" },
        agentId: "cloud",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "dispatching",
      }),
    );
    const request = vi.fn().mockResolvedValueOnce({ session: null });
    const clearRecovery = vi.fn();

    await expect(
      advanceSessionPlacementDraft({
        client: clientWith(request),
        key: "agent:cloud:missing",
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws" },
        message: "missing task",
        messageId: "message-missing",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        recoveryPhase: "dispatching",
        recovering: true,
        isLifecycleCurrent: () => true,
        ownsRecovery: () => true,
        clearRecovery,
        setRecoveryPhase: vi.fn(),
      }),
    ).resolves.toEqual({ status: "cancelled", recoveryPersisted: false });
    expect(request).toHaveBeenCalledTimes(1);
    expect(clearRecovery).toHaveBeenCalledOnce();
  });

  it("keeps a terminal recovery session visible before first-turn sending", async () => {
    sessionStorage.setItem(
      recoveryStorageKey("agent:cloud:pre-send"),
      JSON.stringify({
        sessionKey: "agent:cloud:pre-send",
        messageId: "message-pre-send",
        message: "not sent yet",
        target: { kind: "profile", profileId: "aws" },
        agentId: "cloud",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "dispatching",
      }),
    );
    const request = vi.fn().mockResolvedValueOnce({
      session: { placement: { state: "failed" } },
    });
    const clearRecovery = vi.fn();

    await expect(
      advanceSessionPlacementDraft({
        client: clientWith(request),
        key: "agent:cloud:pre-send",
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws" },
        message: "not sent yet",
        messageId: "message-pre-send",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        recoveryPhase: "dispatching",
        recovering: true,
        isLifecycleCurrent: () => true,
        ownsRecovery: () => true,
        clearRecovery,
        setRecoveryPhase: vi.fn(),
      }),
    ).resolves.toMatchObject({
      status: "paused",
      recovery: {
        reason: "not-sent",
        message: "not sent yet",
        error: "session placement became failed",
      },
    });
    expect(request).not.toHaveBeenCalledWith("sessions.delete", expect.anything());
    expect(clearRecovery).not.toHaveBeenCalled();
  });
});
