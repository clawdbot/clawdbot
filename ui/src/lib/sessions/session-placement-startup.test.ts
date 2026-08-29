/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import {
  GatewayPayloadLimitError,
  GatewayRequestError,
  type GatewayBrowserClient,
} from "../../api/gateway.ts";
import {
  deleteSessionPlacementDraft,
  deleteRecoveredSessionPlacementDraft,
  startSessionPlacementInitialTurn,
} from "./session-placement-startup.ts";

const params = {
  key: "agent:cloud:test",
  agentId: "cloud",
  target: { kind: "profile", profileId: "aws" } as const,
  message: "run remotely",
};

function clientWith(request: ReturnType<typeof vi.fn>): Pick<GatewayBrowserClient, "request"> {
  return { request: request as GatewayBrowserClient["request"] };
}

describe("session placement startup", () => {
  it("stops before the first turn when dispatch fails", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("allocation failed"))
      .mockResolvedValueOnce({ session: { placement: { state: "failed" } } });

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => true),
    ).resolves.toEqual({
      status: "dispatch-rejected",
      error: "allocation failed",
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenCalledWith("sessions.dispatch", {
      key: params.key,
      agentId: params.agentId,
      profileId: params.target.profileId,
    });
    expect(request).toHaveBeenCalledWith("sessions.reclaim", {
      key: params.key,
      agentId: params.agentId,
    });
  });

  it.each([
    {
      name: "profile",
      target: { kind: "profile", profileId: "aws", machineClass: "fast" } as const,
      expectedTarget: { profileId: "aws", machineClass: "fast" },
    },
    {
      name: "device",
      target: { kind: "device", deviceId: "device-1" } as const,
      expectedTarget: { deviceId: "device-1" },
    },
    {
      name: "automatic device",
      target: { kind: "auto-device" } as const,
      expectedTarget: { autoDevice: true },
    },
  ])("serializes a $name target to the flat dispatch contract", async (testCase) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ placement: { state: "active", environmentId: "worker" } })
      .mockResolvedValueOnce({ runId: "run-target" });

    await expect(
      startSessionPlacementInitialTurn(
        clientWith(request),
        { ...params, target: testCase.target },
        () => true,
      ),
    ).resolves.toMatchObject({ status: "started" });
    expect(request).toHaveBeenNthCalledWith(1, "sessions.dispatch", {
      key: params.key,
      agentId: params.agentId,
      ...testCase.expectedTarget,
    });
  });

  it("does not reconcile a definitive dispatch rejection", async () => {
    const request = vi.fn().mockRejectedValue(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "unknown cloud profile",
        retryable: false,
      }),
    );

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => true),
    ).resolves.toEqual({
      status: "dispatch-rejected",
      error: "unknown cloud profile",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalledWith("sessions.describe", expect.anything());
  });

  it("reclaims an allocated worker when provisioning becomes failed", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "provisioning", environmentId: "environment-failed" },
      })
      .mockResolvedValueOnce({
        session: { placement: { state: "failed", environmentId: "environment-failed" } },
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => true),
    ).resolves.toEqual({
      status: "dispatch-rejected",
      error: "session placement became failed",
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.reclaim", {
      key: params.key,
      agentId: params.agentId,
    });
    expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
  });

  it("keeps recovery state when failed-placement cleanup is rejected", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "failed", environmentId: "environment-failed" },
      })
      .mockRejectedValueOnce(new Error("cleanup unavailable"));

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => true),
    ).resolves.toEqual({
      status: "cleanup-rejected",
      error: "cleanup unavailable",
    });
  });

  it("sends after an ambiguous dispatch error when durable placement is active", async () => {
    const attachments = [{ type: "file", mimeType: "text/plain", content: "aGVsbG8=" }];
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport closed"))
      .mockResolvedValueOnce({ session: { placement: { state: "active" } } })
      .mockResolvedValueOnce({ runId: "run-1", messageSeq: 3 });

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), { ...params, attachments }, () => true),
    ).resolves.toMatchObject({
      status: "started",
      messageSeq: 3,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.describe", { key: params.key });
    expect(request).toHaveBeenNthCalledWith(
      3,
      "sessions.send",
      expect.objectContaining({ message: params.message, attachments }),
    );
  });

  it("waits for an absent placement after an ambiguous dispatch error", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport closed"))
      .mockResolvedValueOnce({ session: {} })
      .mockResolvedValueOnce({
        session: { placement: { state: "active", environmentId: "environment-1" } },
      })
      .mockResolvedValueOnce({ runId: "run-1" });

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => true),
    ).resolves.toMatchObject({ status: "started" });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.describe", { key: params.key });
    expect(request).toHaveBeenNthCalledWith(
      4,
      "sessions.send",
      expect.objectContaining({ message: params.message }),
    );
  });

  it("waits for a successful dispatch placement to become active", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "provisioning", environmentId: "environment-1" },
      })
      .mockResolvedValueOnce({
        session: { placement: { state: "active", environmentId: "environment-1" } },
      })
      .mockResolvedValueOnce({ runId: "run-1" });

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => true),
    ).resolves.toMatchObject({ status: "started" });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.describe", { key: params.key });
    expect(request).toHaveBeenNthCalledWith(
      3,
      "sessions.send",
      expect.objectContaining({ message: params.message }),
    );
  });

  it("waits through an in-progress placement after an ambiguous dispatch error", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport closed"))
      .mockResolvedValueOnce({ session: { placement: { state: "provisioning" } } })
      .mockResolvedValueOnce({
        session: { placement: { state: "active", environmentId: "environment-1" } },
      })
      .mockResolvedValueOnce({ runId: "run-1" });

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => true),
    ).resolves.toMatchObject({ status: "started" });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.describe", { key: params.key });
    expect(request).toHaveBeenNthCalledWith(
      4,
      "sessions.send",
      expect.objectContaining({ message: params.message }),
    );
  });

  it("waits for a draining placement to become active during recovery", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport closed"))
      .mockResolvedValueOnce({
        session: { placement: { state: "draining", environmentId: "environment-1" } },
      })
      .mockResolvedValueOnce({
        session: { placement: { state: "active", environmentId: "environment-1" } },
      })
      .mockResolvedValueOnce({ runId: "run-1" });

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => true),
    ).resolves.toMatchObject({ status: "started" });
    expect(request).not.toHaveBeenCalledWith("environments.destroy", expect.anything());
    expect(request).toHaveBeenNthCalledWith(
      4,
      "sessions.send",
      expect.objectContaining({ message: params.message }),
    );
  });

  it("keeps reconciling after a transient placement lookup failure", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport closed"))
      .mockRejectedValueOnce(new Error("still reconnecting"))
      .mockResolvedValueOnce({
        session: { placement: { state: "active", environmentId: "environment-1" } },
      })
      .mockResolvedValueOnce({ runId: "run-1" });

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => true),
    ).resolves.toMatchObject({ status: "started" });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.describe", { key: params.key });
    expect(request).toHaveBeenNthCalledWith(
      4,
      "sessions.send",
      expect.objectContaining({ message: params.message }),
    );
  });

  it("stops quickly when placement lookups remain unavailable", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport closed"))
      .mockRejectedValue(new Error("authentication expired"));

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => true),
    ).resolves.toEqual({
      status: "cleanup-rejected",
      error: "session placement could not be verified; cleanup failed: authentication expired",
    });
    expect(request).toHaveBeenCalledTimes(6);
  });

  it.each([
    {
      name: "reclaims the session placement",
      cleanupError: undefined,
      expectedError: "session placement could not be verified",
    },
    {
      name: "reports a rejected worker cleanup",
      cleanupError: "cleanup unavailable",
      expectedError: "session placement could not be verified; cleanup failed: cleanup unavailable",
    },
  ])("$name when placement lookups remain unavailable", async ({ cleanupError, expectedError }) => {
    vi.useFakeTimers();
    try {
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          placement: { state: "provisioning", environmentId: "environment-unavailable" },
        })
        .mockRejectedValueOnce(new Error("lookup unavailable 1"))
        .mockRejectedValueOnce(new Error("lookup unavailable 2"))
        .mockRejectedValueOnce(new Error("lookup unavailable 3"))
        .mockRejectedValueOnce(new Error("lookup unavailable 4"));
      if (cleanupError) {
        request.mockRejectedValueOnce(new Error(cleanupError));
      } else {
        request.mockResolvedValueOnce({ worker: { state: "destroyed" } });
      }

      const outcome = startSessionPlacementInitialTurn(clientWith(request), params, () => true);
      await vi.runAllTimersAsync();

      await expect(outcome).resolves.toEqual({ status: "cleanup-rejected", error: expectedError });
      expect(request).toHaveBeenCalledTimes(6);
      expect(request).toHaveBeenNthCalledWith(6, "sessions.reclaim", {
        key: params.key,
        agentId: params.agentId,
      });
      expect(request).not.toHaveBeenCalledWith("sessions.abort", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a still-provisioning placement recoverable after reconciliation times out", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockResolvedValue({
        placement: { state: "provisioning", environmentId: "environment-slow" },
        session: { placement: { state: "provisioning", environmentId: "environment-slow" } },
      });

      const outcome = startSessionPlacementInitialTurn(clientWith(request), params, () => true);
      await vi.runAllTimersAsync();
      await expect(outcome).resolves.toEqual({
        status: "cleanup-rejected",
        error: "session placement reconciliation timed out",
      });
      expect(request).not.toHaveBeenCalledWith("sessions.reclaim", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a cancelled placement recoverable when reclaim fails", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ placement: { state: "active", environmentId: "environment-1" } })
      .mockRejectedValueOnce(new Error("cleanup unavailable"));

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => false),
    ).resolves.toEqual({
      status: "cleanup-rejected",
      error: "cleanup unavailable",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.reclaim", {
      key: params.key,
      agentId: params.agentId,
    });
    expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
  });

  it("cancels provisioning promptly while reconciling an ambiguous dispatch", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport closed"))
      .mockResolvedValueOnce({
        session: { placement: { state: "provisioning", environmentId: "environment-1" } },
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => false),
    ).resolves.toEqual({
      status: "cancelled",
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.reclaim", {
      key: params.key,
      agentId: params.agentId,
    });
    expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
  });

  it("reclaims by session when cancellation coincides with a lookup failure", async () => {
    let current = true;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "provisioning", environmentId: "environment-1" },
      })
      .mockImplementationOnce(async () => {
        current = false;
        throw new Error("reconnecting");
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => current),
    ).resolves.toEqual({ status: "cancelled" });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.reclaim", {
      key: params.key,
      agentId: params.agentId,
    });
  });

  it("reclaims without carrying an environment identity", async () => {
    let current = true;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "provisioning", environmentId: "environment-1" },
      })
      .mockImplementationOnce(async () => {
        current = false;
        return { session: { placement: { state: "provisioning" } } };
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => current),
    ).resolves.toEqual({ status: "cancelled" });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.reclaim", {
      key: params.key,
      agentId: params.agentId,
    });
  });

  it("aborts and reclaims when cancellation lands while the first turn is in flight", async () => {
    let current = true;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "active", environmentId: "environment-1" },
      })
      .mockImplementationOnce(async () => {
        current = false;
        return { runId: "run-1" };
      })
      .mockResolvedValueOnce({ ok: true, status: "aborted" })
      .mockResolvedValueOnce({ ok: true });

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => current),
    ).resolves.toEqual({
      status: "cancelled",
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.abort", {
      key: params.key,
      agentId: params.agentId,
    });
    expect(request).toHaveBeenNthCalledWith(4, "sessions.reclaim", {
      key: params.key,
      agentId: params.agentId,
    });
  });

  it("keeps the accepted message identity when post-send cleanup fails", async () => {
    let current = true;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "active", environmentId: "environment-1" },
      })
      .mockImplementationOnce(async (_method, requestParams) => {
        current = false;
        return { runId: "run-1", requestParams };
      })
      .mockResolvedValueOnce({ ok: true, status: "aborted" })
      .mockRejectedValueOnce(new Error("cleanup unavailable"));

    const outcome = await startSessionPlacementInitialTurn(
      clientWith(request),
      params,
      () => current,
    );
    const sent = request.mock.calls[1]?.[1] as { idempotencyKey: string };
    expect(outcome).toEqual({
      status: "cleanup-rejected",
      error: "cleanup unavailable",
      messageId: sent.idempotencyKey,
    });
  });

  it("reclaims the worker after a definitive first-turn rejection", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "active", environmentId: "environment-1" },
      })
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "message rejected",
          retryable: false,
        }),
      )
      .mockResolvedValueOnce({ ok: true });

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => true),
    ).resolves.toEqual({
      status: "send-definitive-rejected",
      error: "message rejected",
      messageId: expect.any(String),
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.reclaim", {
      key: params.key,
      agentId: params.agentId,
    });
  });

  it("does not redispatch a terminal placement during recovery", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ session: { placement: { state: "failed" } } })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        placement: { state: "active", environmentId: "environment-2" },
      })
      .mockResolvedValueOnce({ runId: "run-2" });

    await expect(
      startSessionPlacementInitialTurn(
        clientWith(request),
        {
          ...params,
          messageId: "message-recovered",
          recovering: true,
        },
        () => true,
      ),
    ).resolves.toEqual({ status: "dispatch-rejected", error: "session placement became failed" });
    expect(request).not.toHaveBeenCalledWith("sessions.dispatch", expect.anything());
    expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
  });

  it("reclaims the worker without sending when recovery cannot enter the sending phase", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "active", environmentId: "environment-1" },
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(
      startSessionPlacementInitialTurn(
        clientWith(request),
        { ...params, messageId: "message-retained" },
        () => true,
        () => false,
      ),
    ).resolves.toEqual({
      status: "send-not-started",
      messageId: "message-retained",
      error: "placement recovery storage is unavailable",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.reclaim", {
      key: params.key,
      agentId: params.agentId,
    });
    expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
  });

  it.each([
    { error: new GatewayPayloadLimitError(), status: "send-not-started", cleanupFails: false },
    { error: new Error("gateway not connected"), status: "send-not-started", cleanupFails: true },
    {
      error: new GatewayRequestError({ code: "INVALID_REQUEST", message: "send rejected" }),
      status: "send-definitive-rejected",
      cleanupFails: true,
    },
  ])(
    "preserves $status classification when cleanup fails=$cleanupFails",
    async ({ error, status, cleanupFails }) => {
      const request = vi.fn((method: string) => {
        if (method === "sessions.dispatch") {
          return Promise.resolve({ placement: { state: "active" } });
        }
        if (method === "sessions.send") {
          return Promise.reject(error);
        }
        if (method === "sessions.reclaim") {
          return cleanupFails
            ? Promise.reject(new Error("cleanup unavailable"))
            : Promise.resolve({ ok: true });
        }
        throw new Error(`unexpected method ${method}`);
      });
      await expect(
        startSessionPlacementInitialTurn(
          clientWith(request),
          { ...params, messageId: "retained" },
          () => true,
        ),
      ).resolves.toEqual({
        status,
        messageId: "retained",
        error: error.message + (cleanupFails ? "; cleanup failed: cleanup unavailable" : ""),
      });
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "sessions.dispatch",
        "sessions.send",
        "sessions.reclaim",
      ]);
    },
  );

  it("reclaims a cancelled placement without an environment identity", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ placement: { state: "active" } })
      .mockResolvedValueOnce({ ok: true });

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => false),
    ).resolves.toEqual({
      status: "cancelled",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.reclaim", {
      key: params.key,
      agentId: params.agentId,
    });
  });

  it("archives and deletes a cancelled local draft session", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ session: { sessionId: "session-draft" } })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, deleted: true });

    await expect(
      deleteSessionPlacementDraft(clientWith(request), params.key, params.agentId),
    ).resolves.toBeUndefined();

    expect(request.mock.calls).toEqual([
      ["sessions.describe", { key: params.key }],
      [
        "sessions.patch",
        {
          key: params.key,
          agentId: params.agentId,
          archived: true,
          expectedSessionId: "session-draft",
        },
      ],
      [
        "sessions.delete",
        {
          key: params.key,
          agentId: params.agentId,
          deleteTranscript: true,
          expectedSessionId: "session-draft",
          archivedOnly: true,
        },
      ],
    ]);
  });

  it.each([
    {
      name: "delete no-op",
      deleteResult: { ok: true, deleted: false },
      expectedError: "placement draft session was not deleted",
    },
    {
      name: "delete rejection",
      deleteResult: new Error("delete unavailable"),
      expectedError: "delete unavailable",
    },
  ])("unarchives a local draft after $name", async ({ deleteResult, expectedError }) => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.describe") {
        return { session: { sessionId: "session-draft" } };
      }
      if (method === "sessions.delete") {
        if (deleteResult instanceof Error) {
          throw deleteResult;
        }
        return deleteResult;
      }
      return { ok: true };
    });

    await expect(
      deleteSessionPlacementDraft(clientWith(request), params.key, params.agentId),
    ).resolves.toBe(expectedError);
    expect(request).toHaveBeenLastCalledWith("sessions.patch", {
      key: params.key,
      agentId: params.agentId,
      archived: false,
      expectedSessionId: "session-draft",
    });
  });

  it("reports both delete and restore failures during local draft cleanup", async () => {
    let patchCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.describe") {
        return { session: { sessionId: "session-draft" } };
      }
      if (method === "sessions.delete") {
        throw new Error("delete unavailable");
      }
      patchCalls += 1;
      if (patchCalls === 2) {
        throw new Error("restore unavailable");
      }
      return { ok: true };
    });

    await expect(
      deleteSessionPlacementDraft(clientWith(request), params.key, params.agentId),
    ).resolves.toBe(
      "delete unavailable; restoring the placement draft failed: restore unavailable",
    );
  });

  it("reclaims a recovered worker before archiving and deleting its draft session", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        session: {
          sessionId: "session-recovered",
          placement: { state: "active", environmentId: "environment-recovered" },
        },
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, deleted: true });

    await expect(
      deleteRecoveredSessionPlacementDraft(clientWith(request), params.key, params.agentId),
    ).resolves.toBeUndefined();
    expect(request.mock.calls).toEqual([
      ["sessions.describe", { key: params.key }],
      ["sessions.reclaim", { key: params.key, agentId: params.agentId }],
      [
        "sessions.patch",
        {
          key: params.key,
          agentId: params.agentId,
          archived: true,
          expectedSessionId: "session-recovered",
        },
      ],
      [
        "sessions.delete",
        {
          key: params.key,
          agentId: params.agentId,
          deleteTranscript: true,
          expectedSessionId: "session-recovered",
          archivedOnly: true,
        },
      ],
    ]);
  });

  it("retains a recovered draft when worker placement cannot be verified", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("gateway unavailable"));

    await expect(
      deleteRecoveredSessionPlacementDraft(clientWith(request), params.key, params.agentId),
    ).resolves.toBe("session placement could not be verified");
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("sessions.describe", { key: params.key });
  });

  it("treats a missing recovered session as already cleaned up", async () => {
    const request = vi.fn().mockResolvedValueOnce({ session: null });

    await expect(
      deleteRecoveredSessionPlacementDraft(clientWith(request), params.key, params.agentId),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns the same idempotency key when first-turn sending fails", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "active", environmentId: "environment-1" },
      })
      .mockRejectedValueOnce(new Error("transport closed"));

    const outcome = await startSessionPlacementInitialTurn(clientWith(request), params, () => true);
    expect(outcome).toMatchObject({ status: "send-rejected", error: "transport closed" });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "sessions.send",
      expect.objectContaining({
        key: params.key,
        message: params.message,
        idempotencyKey: (outcome as { messageId: string }).messageId,
      }),
    );
  });

  it("reuses a supplied recovery idempotency key", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "active", environmentId: "environment-1" },
      })
      .mockRejectedValueOnce(new Error("transport closed again"));

    const outcome = await startSessionPlacementInitialTurn(
      clientWith(request),
      { ...params, messageId: "recovery-message-1" },
      () => true,
    );

    expect(outcome).toMatchObject({ status: "send-rejected", messageId: "recovery-message-1" });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "sessions.send",
      expect.objectContaining({ idempotencyKey: "recovery-message-1" }),
    );
  });

  it("reuses an active recovered worker without dispatching another one", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        session: { placement: { state: "active", environmentId: "environment-existing" } },
      })
      .mockResolvedValueOnce({ runId: "run-recovered" });

    await expect(
      startSessionPlacementInitialTurn(
        clientWith(request),
        { ...params, recovering: true, messageId: "recovery-message-1" },
        () => true,
      ),
    ).resolves.toEqual({ status: "started", messageId: "recovery-message-1" });
    expect(request).not.toHaveBeenCalledWith("sessions.dispatch", expect.anything());
    expect(request).toHaveBeenNthCalledWith(1, "sessions.describe", { key: params.key });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "sessions.send",
      expect.objectContaining({ idempotencyKey: "recovery-message-1" }),
    );
  });
});
