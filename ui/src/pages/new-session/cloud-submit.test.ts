import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { cloudSessionRecoveryExactStorageKey } from "../../lib/sessions/cloud-recovery-storage-key.ts";
import {
  clearCloudSessionRecovery,
  readCloudSessionRecovery,
  type CloudSessionRecovery,
  writeCloudSessionRecovery,
} from "../../lib/sessions/cloud-recovery.ts";
import { advanceCloudDraftSession as advanceCloudDraftSessionWithRecovery } from "../../lib/sessions/cloud-submit.ts";

type AdvanceParams = Omit<
  Parameters<typeof advanceCloudDraftSessionWithRecovery>[0],
  "cleanupOnCancellation" | "recovery"
> &
  Omit<CloudSessionRecovery, "sessionKey" | "phase"> & {
    cleanupOnCancellation?: boolean;
    key: string;
    recoveryPhase: CloudSessionRecovery["phase"];
  };

function advanceCloudDraftSession(params: AdvanceParams) {
  const {
    key,
    messageId,
    message,
    attachments,
    profileId,
    machineClass,
    agentId,
    gatewayUrl,
    recoveryScope,
    recoveryPhase,
    ...options
  } = params;
  return advanceCloudDraftSessionWithRecovery({
    ...options,
    cleanupOnCancellation: options.cleanupOnCancellation ?? true,
    recovery: {
      sessionKey: key,
      messageId,
      message,
      attachments,
      profileId,
      machineClass,
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
  cloudSessionRecoveryExactStorageKey("ws://gateway.example", "principal-a", sessionKey);

describe("cloud draft advancement", () => {
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
        profileId: "aws",
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
    const request = vi.fn();
    const clearRecovery = vi.fn();

    await expect(
      advanceCloudDraftSession({
        client: clientWith(request),
        key: "agent:cloud:recovered",
        agentId: "cloud",
        profileId: "aws",
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
    ).resolves.toEqual({
      status: "cancelled",
      cleanupError: "cloud recovery storage is unavailable",
      recoveryPersisted: false,
    });
    expect(request).not.toHaveBeenCalled();
    expect(clearRecovery).not.toHaveBeenCalled();
  });

  it("sends an older startup in memory without replacing a newer durable session", async () => {
    const gatewayUrl = "ws://gateway.example";
    const recoveryScope = "principal-a";
    const sessionKey = "agent:cloud:older";
    const newerRecovery: CloudSessionRecovery = {
      sessionKey: "agent:cloud:newer",
      messageId: "message-newer",
      message: "newer task",
      profileId: "aws",
      agentId: "cloud",
      gatewayUrl,
      recoveryScope,
      phase: "dispatching",
    };
    const request = vi.fn((method: string) => {
      if (method === "sessions.dispatch") {
        expect(writeCloudSessionRecovery(newerRecovery)).toBe(true);
        return Promise.resolve({ placement: { state: "active", environmentId: "worker-older" } });
      }
      if (method === "sessions.send") {
        return Promise.resolve({ runId: "run-older", status: "started" });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const setRecoveryPhase = vi.fn();
    const clearRecovery = vi.fn(() =>
      clearCloudSessionRecovery(gatewayUrl, recoveryScope, sessionKey),
    );

    await expect(
      advanceCloudDraftSession({
        client: clientWith(request),
        key: sessionKey,
        agentId: "cloud",
        profileId: "aws",
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
    expect(readCloudSessionRecovery(gatewayUrl, recoveryScope, newerRecovery.sessionKey)).toEqual(
      newerRecovery,
    );
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
      advanceCloudDraftSession({
        client: clientWith(request),
        key: "agent:cloud:current",
        agentId: "cloud",
        profileId: "aws",
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
    ).resolves.toEqual({
      status: "dispatch-rejected",
      error: "cloud recovery storage is unavailable",
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
        profileId: "aws",
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
      advanceCloudDraftSession({
        client: clientWith(request),
        key: "agent:cloud:stale",
        agentId: "cloud",
        profileId: "aws",
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
      profileId: "aws",
      agentId: "cloud",
      gatewayUrl,
      recoveryScope,
      phase: "dispatching" as const,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ placement: { state: "active", environmentId: "environment-1" } })
      .mockImplementationOnce(async () => {
        if (!recoveryOwned) {
          expect(writeCloudSessionRecovery(newerRecovery)).toBe(true);
        }
        return { runId: "run-stale", status: "started" };
      });
    // Both fences stay current through the helper's five safety checks. One
    // independent fact changes before the caller classifies accepted delivery.
    let lifecycleChecks = 0;
    let ownershipChecks = 0;
    const clearRecovery = vi.fn(() =>
      clearCloudSessionRecovery(gatewayUrl, recoveryScope, sessionKey),
    );

    await expect(
      advanceCloudDraftSession({
        client: clientWith(request),
        key: sessionKey,
        agentId: "cloud",
        profileId: "aws",
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
    expect(readCloudSessionRecovery(gatewayUrl, recoveryScope, newerRecovery.sessionKey)).toEqual(
      recoveryOwned ? null : newerRecovery,
    );
  });

  it("does not persist volatile incognito recovery when submission is cancelled", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ session: { sessionId: "session-incognito" } })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, deleted: true });

    await expect(
      advanceCloudDraftSession({
        client: clientWith(request),
        key: "agent:cloud:incognito",
        agentId: "cloud",
        profileId: "aws",
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
      advanceCloudDraftSession({
        client: clientWith(request),
        key: "agent:cloud:cancelled",
        agentId: "cloud",
        profileId: "aws",
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

  it("redispatches a recovered transcript after terminal placement", async () => {
    sessionStorage.setItem(
      recoveryStorageKey("agent:cloud:recovered"),
      JSON.stringify({
        sessionKey: "agent:cloud:recovered",
        messageId: "message-recovered",
        message: "possibly accepted task",
        profileId: "aws",
        machineClass: "fast",
        agentId: "cloud",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "sending",
      }),
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce({ session: { placement: { state: "failed" } } })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ placement: { state: "active", environmentId: "environment-2" } })
      .mockRejectedValueOnce(new Error("send response lost"));
    const clearRecovery = vi.fn();

    await expect(
      advanceCloudDraftSession({
        client: clientWith(request),
        key: "agent:cloud:recovered",
        agentId: "cloud",
        profileId: "aws",
        machineClass: "fast",
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
    ).resolves.toEqual({
      status: "send-rejected",
      error: "send response lost",
      messageId: "message-recovered",
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.dispatch", {
      key: "agent:cloud:recovered",
      agentId: "cloud",
      profileId: "aws",
      machineClass: "fast",
    });
    expect(request).toHaveBeenNthCalledWith(
      4,
      "sessions.send",
      expect.objectContaining({ idempotencyKey: "message-recovered" }),
    );
    expect(request).not.toHaveBeenCalledWith("sessions.delete", expect.anything());
    expect(clearRecovery).not.toHaveBeenCalled();
  });

  it("keeps the visible session after a definitive redispatch rejection", async () => {
    sessionStorage.setItem(
      recoveryStorageKey("agent:cloud:recovered"),
      JSON.stringify({
        sessionKey: "agent:cloud:recovered",
        messageId: "message-recovered",
        message: "retry this task",
        profileId: "aws",
        agentId: "cloud",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "sending",
      }),
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce({ session: { placement: { state: "failed" } } })
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "cloud profile was removed",
          retryable: false,
        }),
      );
    const clearRecovery = vi.fn();

    await expect(
      advanceCloudDraftSession({
        client: clientWith(request),
        key: "agent:cloud:recovered",
        agentId: "cloud",
        profileId: "aws",
        message: "retry this task",
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
    ).resolves.toEqual({ status: "dispatch-rejected", error: "cloud profile was removed" });
    expect(request).not.toHaveBeenCalledWith("sessions.delete", expect.anything());
    expect(clearRecovery).toHaveBeenCalledOnce();
  });

  it("clears recovery when its draft session no longer exists", async () => {
    sessionStorage.setItem(
      recoveryStorageKey("agent:cloud:missing"),
      JSON.stringify({
        sessionKey: "agent:cloud:missing",
        messageId: "message-missing",
        message: "missing task",
        profileId: "aws",
        agentId: "cloud",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "sending",
      }),
    );
    const request = vi.fn().mockResolvedValueOnce({ session: null });
    const clearRecovery = vi.fn();

    await expect(
      advanceCloudDraftSession({
        client: clientWith(request),
        key: "agent:cloud:missing",
        agentId: "cloud",
        profileId: "aws",
        message: "missing task",
        messageId: "message-missing",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        recoveryPhase: "sending",
        recovering: true,
        isLifecycleCurrent: () => true,
        ownsRecovery: () => true,
        clearRecovery,
        setRecoveryPhase: vi.fn(),
      }),
    ).resolves.toEqual({
      status: "dispatch-rejected",
      error: "cloud draft session no longer exists",
    });
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
        profileId: "aws",
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
      advanceCloudDraftSession({
        client: clientWith(request),
        key: "agent:cloud:pre-send",
        agentId: "cloud",
        profileId: "aws",
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
    ).resolves.toEqual({
      status: "dispatch-rejected",
      error: "cloud worker placement became failed",
    });
    expect(request).not.toHaveBeenCalledWith("sessions.delete", expect.anything());
    expect(clearRecovery).toHaveBeenCalledOnce();
  });
});
