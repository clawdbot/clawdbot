/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  deleteCloudDraftSession,
  deleteRecoveredCloudDraftSession,
  renderCloudProfileMenuItems,
  startCloudInitialTurn,
} from "./cloud-target.ts";

const params = {
  key: "agent:cloud:test",
  agentId: "cloud",
  profileId: "aws",
  message: "run remotely",
};

function clientWith(request: ReturnType<typeof vi.fn>): Pick<GatewayBrowserClient, "request"> {
  return { request: request as GatewayBrowserClient["request"] };
}

describe("cloud session startup", () => {
  it("stops before the first turn when dispatch fails", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("allocation failed"))
      .mockResolvedValueOnce({ session: { placement: { state: "failed" } } });

    await expect(startCloudInitialTurn(clientWith(request), params, () => true)).resolves.toEqual({
      status: "dispatch-rejected",
      error: "allocation failed",
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith("sessions.dispatch", {
      key: params.key,
      agentId: params.agentId,
      profileId: params.profileId,
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

    await expect(startCloudInitialTurn(clientWith(request), params, () => true)).resolves.toEqual({
      status: "dispatch-rejected",
      error: "unknown cloud profile",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalledWith("sessions.describe", expect.anything());
  });

  it("destroys an allocated worker when provisioning becomes failed", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "provisioning", environmentId: "environment-failed" },
      })
      .mockResolvedValueOnce({
        session: { placement: { state: "failed", environmentId: "environment-failed" } },
      })
      .mockResolvedValueOnce({ worker: { state: "destroyed" } });

    await expect(startCloudInitialTurn(clientWith(request), params, () => true)).resolves.toEqual({
      status: "dispatch-rejected",
      error: "cloud worker placement became failed",
    });
    expect(request).toHaveBeenNthCalledWith(3, "environments.destroy", {
      environmentId: "environment-failed",
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

    await expect(startCloudInitialTurn(clientWith(request), params, () => true)).resolves.toEqual({
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
      .mockResolvedValueOnce({ runId: "run-1" });

    await expect(
      startCloudInitialTurn(clientWith(request), { ...params, attachments }, () => true),
    ).resolves.toMatchObject({
      status: "started",
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
      startCloudInitialTurn(clientWith(request), params, () => true),
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
      startCloudInitialTurn(clientWith(request), params, () => true),
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
      startCloudInitialTurn(clientWith(request), params, () => true),
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
      startCloudInitialTurn(clientWith(request), params, () => true),
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
      startCloudInitialTurn(clientWith(request), params, () => true),
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

    await expect(startCloudInitialTurn(clientWith(request), params, () => true)).resolves.toEqual({
      status: "cleanup-rejected",
      error: "cloud worker placement could not be verified",
    });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("keeps a still-provisioning placement recoverable after reconciliation times out", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockResolvedValue({
        placement: { state: "provisioning", environmentId: "environment-slow" },
        session: { placement: { state: "provisioning", environmentId: "environment-slow" } },
      });

      const outcome = startCloudInitialTurn(clientWith(request), params, () => true);
      await vi.runAllTimersAsync();
      await expect(outcome).resolves.toEqual({
        status: "cleanup-rejected",
        error: "cloud worker placement reconciliation timed out",
      });
      expect(request).not.toHaveBeenCalledWith("environments.destroy", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a cancelled placement recoverable when destruction fails", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ placement: { state: "active", environmentId: "environment-1" } })
      .mockRejectedValueOnce(new Error("cleanup unavailable"));

    await expect(startCloudInitialTurn(clientWith(request), params, () => false)).resolves.toEqual({
      status: "cleanup-rejected",
      error: "cleanup unavailable",
    });
    expect(request).toHaveBeenNthCalledWith(2, "environments.destroy", {
      environmentId: "environment-1",
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
      .mockResolvedValueOnce({ worker: { state: "destroyed" } });

    await expect(startCloudInitialTurn(clientWith(request), params, () => false)).resolves.toEqual({
      status: "cancelled",
    });
    expect(request).toHaveBeenNthCalledWith(3, "environments.destroy", {
      environmentId: "environment-1",
    });
    expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
  });

  it("destroys the last known worker when cancellation coincides with a lookup failure", async () => {
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
      .mockResolvedValueOnce({ worker: { state: "destroyed" } });

    await expect(
      startCloudInitialTurn(clientWith(request), params, () => current),
    ).resolves.toEqual({ status: "cancelled" });
    expect(request).toHaveBeenNthCalledWith(3, "environments.destroy", {
      environmentId: "environment-1",
    });
  });

  it("preserves the last known worker identity when a later placement omits it", async () => {
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
      .mockResolvedValueOnce({ worker: { state: "destroyed" } });

    await expect(
      startCloudInitialTurn(clientWith(request), params, () => current),
    ).resolves.toEqual({ status: "cancelled" });
    expect(request).toHaveBeenNthCalledWith(3, "environments.destroy", {
      environmentId: "environment-1",
    });
  });

  it("aborts and destroys when cancellation lands while the first turn is in flight", async () => {
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
      .mockResolvedValueOnce({ worker: { state: "destroyed" } });

    await expect(
      startCloudInitialTurn(clientWith(request), params, () => current),
    ).resolves.toEqual({
      status: "cancelled",
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.abort", {
      key: params.key,
      agentId: params.agentId,
    });
    expect(request).toHaveBeenNthCalledWith(4, "environments.destroy", {
      environmentId: "environment-1",
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

    const outcome = await startCloudInitialTurn(clientWith(request), params, () => current);
    const sent = request.mock.calls[1]?.[1] as { idempotencyKey: string };
    expect(outcome).toEqual({
      status: "cleanup-rejected",
      error: "cleanup unavailable",
      messageId: sent.idempotencyKey,
    });
  });

  it("destroys the worker after a definitive first-turn rejection", async () => {
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
      .mockResolvedValueOnce({ worker: { state: "destroyed" } });

    await expect(startCloudInitialTurn(clientWith(request), params, () => true)).resolves.toEqual({
      status: "send-definitive-rejected",
      error: "message rejected",
      messageId: expect.any(String),
    });
    expect(request).toHaveBeenNthCalledWith(3, "environments.destroy", {
      environmentId: "environment-1",
    });
  });

  it("redispatches terminal sending recovery with the same message identity", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ session: { placement: { state: "failed" } } })
      .mockResolvedValueOnce({
        placement: { state: "active", environmentId: "environment-2" },
      })
      .mockResolvedValueOnce({ runId: "run-2" });

    await expect(
      startCloudInitialTurn(
        clientWith(request),
        {
          ...params,
          messageId: "message-recovered",
          recovering: true,
          retryTerminalPlacement: true,
        },
        () => true,
      ),
    ).resolves.toEqual({ status: "started", messageId: "message-recovered" });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.dispatch", {
      key: params.key,
      agentId: params.agentId,
      profileId: params.profileId,
    });
    expect(request).toHaveBeenNthCalledWith(
      3,
      "sessions.send",
      expect.objectContaining({ idempotencyKey: "message-recovered" }),
    );
  });

  it("destroys the worker without sending when recovery cannot enter the sending phase", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "active", environmentId: "environment-1" },
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(
      startCloudInitialTurn(
        clientWith(request),
        params,
        () => true,
        () => false,
      ),
    ).resolves.toEqual({
      status: "send-not-started",
      error: "cloud recovery storage is unavailable",
    });
    expect(request).toHaveBeenNthCalledWith(2, "environments.destroy", {
      environmentId: "environment-1",
    });
    expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
  });

  it("reports lost worker identity instead of claiming cancellation succeeded", async () => {
    const request = vi.fn().mockResolvedValueOnce({ placement: { state: "active" } });

    await expect(startCloudInitialTurn(clientWith(request), params, () => false)).resolves.toEqual({
      status: "cleanup-rejected",
      error: "cloud worker cleanup lost its environment identity",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("deletes a cancelled local draft session", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, deleted: true });

    await expect(
      deleteCloudDraftSession(clientWith(request), params.key, params.agentId),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledWith("sessions.delete", {
      key: params.key,
      agentId: params.agentId,
      deleteTranscript: true,
    });
  });

  it("reports a rejected local draft cleanup", async () => {
    const request = vi.fn().mockRejectedValue(new Error("delete unavailable"));

    await expect(
      deleteCloudDraftSession(clientWith(request), params.key, params.agentId),
    ).resolves.toBe("delete unavailable");
  });

  it("destroys a recovered worker before deleting its draft session", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        session: { placement: { state: "active", environmentId: "environment-recovered" } },
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, deleted: true });

    await expect(
      deleteRecoveredCloudDraftSession(clientWith(request), params.key, params.agentId),
    ).resolves.toBeUndefined();
    expect(request.mock.calls).toEqual([
      ["sessions.describe", { key: params.key }],
      ["environments.destroy", { environmentId: "environment-recovered" }],
      ["sessions.delete", { key: params.key, agentId: params.agentId, deleteTranscript: true }],
    ]);
  });

  it("retains a recovered draft when worker placement cannot be verified", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("gateway unavailable"));

    await expect(
      deleteRecoveredCloudDraftSession(clientWith(request), params.key, params.agentId),
    ).resolves.toBe("cloud worker placement could not be verified");
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("sessions.describe", { key: params.key });
  });

  it("treats a missing recovered session as already cleaned up", async () => {
    const request = vi.fn().mockResolvedValueOnce({ session: null });

    await expect(
      deleteRecoveredCloudDraftSession(clientWith(request), params.key, params.agentId),
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

    const outcome = await startCloudInitialTurn(clientWith(request), params, () => true);
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

    const outcome = await startCloudInitialTurn(
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
      startCloudInitialTurn(
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

describe("cloud target menu", () => {
  it("disables cloud profiles with the runtime preflight reason", () => {
    const container = document.createElement("div");
    render(
      renderCloudProfileMenuItems({
        profiles: [{ id: "aws", providerId: "crabbox" }],
        selectedId: "",
        submitting: false,
        disabled: true,
        disabledReason: "Cloud workers require the OpenClaw runtime; codex is selected.",
        onSelect: vi.fn(),
      }),
      container,
    );

    const button = container.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]');
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe("Cloud workers require the OpenClaw runtime; codex is selected.");
  });
});
