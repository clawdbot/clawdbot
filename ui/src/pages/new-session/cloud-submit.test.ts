import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  clearCloudSessionRecovery,
  readCloudSessionRecovery,
  writeCloudSessionRecovery,
} from "./cloud-recovery.ts";
import { advanceCloudDraftSession } from "./cloud-submit.ts";

function clientWith(request: ReturnType<typeof vi.fn>): Pick<GatewayBrowserClient, "request"> {
  return { request: request as GatewayBrowserClient["request"] };
}

describe("cloud draft advancement", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves a recovered session when recovery storage becomes unavailable", async () => {
    sessionStorage.setItem(
      "openclaw.new-session.cloud-recovery.v1:ws://gateway.example:principal-a",
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

  it("does not overwrite recovery after submission ownership is lost", async () => {
    sessionStorage.setItem(
      "openclaw.new-session.cloud-recovery.v1:ws://gateway.example:principal-a",
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
    const request = vi.fn().mockResolvedValueOnce({ ok: true, deleted: true });
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
      JSON.parse(
        sessionStorage.getItem(
          "openclaw.new-session.cloud-recovery.v1:ws://gateway.example:principal-a",
        ) ?? "null",
      ),
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
    expect(readCloudSessionRecovery(gatewayUrl, recoveryScope)).toEqual(
      recoveryOwned ? null : newerRecovery,
    );
  });

  it("does not persist volatile incognito recovery when submission is cancelled", async () => {
    const request = vi.fn().mockResolvedValueOnce({ ok: true, deleted: true });

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
    expect(sessionStorage.length).toBe(0);
  });

  it("keeps a cancelled draft recoverable when its cleanup fails", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("delete unavailable"));
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
      JSON.parse(
        sessionStorage.getItem(
          "openclaw.new-session.cloud-recovery.v1:ws://gateway.example:principal-a",
        ) ?? "null",
      ),
    ).toMatchObject({ sessionKey: "agent:cloud:cancelled" });
    expect(clearRecovery).not.toHaveBeenCalled();
  });

  it("redispatches a recovered transcript after terminal placement", async () => {
    sessionStorage.setItem(
      "openclaw.new-session.cloud-recovery.v1:ws://gateway.example:principal-a",
      JSON.stringify({
        sessionKey: "agent:cloud:recovered",
        messageId: "message-recovered",
        message: "possibly accepted task",
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
      .mockResolvedValueOnce({ placement: { state: "active", environmentId: "environment-2" } })
      .mockRejectedValueOnce(new Error("send response lost"));
    const clearRecovery = vi.fn();

    await expect(
      advanceCloudDraftSession({
        client: clientWith(request),
        key: "agent:cloud:recovered",
        agentId: "cloud",
        profileId: "aws",
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
    expect(request).toHaveBeenNthCalledWith(2, "sessions.dispatch", {
      key: "agent:cloud:recovered",
      agentId: "cloud",
      profileId: "aws",
    });
    expect(request).toHaveBeenNthCalledWith(
      3,
      "sessions.send",
      expect.objectContaining({ idempotencyKey: "message-recovered" }),
    );
    expect(request).not.toHaveBeenCalledWith("sessions.delete", expect.anything());
    expect(clearRecovery).not.toHaveBeenCalled();
  });

  it("abandons recovery after a definitive redispatch rejection", async () => {
    sessionStorage.setItem(
      "openclaw.new-session.cloud-recovery.v1:ws://gateway.example:principal-a",
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
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "cloud profile was removed",
          retryable: false,
        }),
      )
      .mockResolvedValueOnce({ ok: true, deleted: true });
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
    expect(request).toHaveBeenNthCalledWith(3, "sessions.delete", {
      key: "agent:cloud:recovered",
      agentId: "cloud",
      deleteTranscript: true,
    });
    expect(clearRecovery).toHaveBeenCalledOnce();
  });

  it("clears recovery when its draft session no longer exists", async () => {
    sessionStorage.setItem(
      "openclaw.new-session.cloud-recovery.v1:ws://gateway.example:principal-a",
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

  it("deletes a terminal recovery that never reached first-turn sending", async () => {
    sessionStorage.setItem(
      "openclaw.new-session.cloud-recovery.v1:ws://gateway.example:principal-a",
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
    const request = vi
      .fn()
      .mockResolvedValueOnce({ session: { placement: { state: "failed" } } })
      .mockResolvedValueOnce({ ok: true, deleted: true });
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
    expect(request).toHaveBeenNthCalledWith(2, "sessions.delete", {
      key: "agent:cloud:pre-send",
      agentId: "cloud",
      deleteTranscript: true,
    });
    expect(clearRecovery).toHaveBeenCalledOnce();
  });
});
