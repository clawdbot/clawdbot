import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../cron/types.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

import { sendGatewayCronWebhook } from "./server-cron-notifications.js";

function createWebhookJob(): CronJob {
  return {
    id: "primary-webhook-deadline",
    name: "primary webhook deadline",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    delivery: { mode: "webhook", to: "https://example.invalid/cron" },
    state: {},
  };
}

describe("sendGatewayCronWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propagates cancellation and the remaining run deadline without retrying", async () => {
    const controller = new AbortController();
    const ssrfPolicy = { allowedHostnames: ["127.0.0.1"] };
    mocks.fetchWithSsrFGuard.mockImplementationOnce(async (value: unknown) => {
      const request = value as { signal?: AbortSignal };
      const signal = request.signal;
      if (!signal) {
        throw new Error("expected run abort signal");
      }
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error(String(signal.reason ?? "aborted"))),
          { once: true },
        );
      });
    });
    const job = createWebhookJob();
    const deadlineAtMs = Date.now() + 5_000;
    const delivery = sendGatewayCronWebhook({
      event: { jobId: job.id, action: "finished", status: "ok", summary: "done" },
      job,
      abortSignal: controller.signal,
      deadlineAtMs,
      ssrfPolicy,
    });

    await vi.waitFor(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce());
    const request = mocks.fetchWithSsrFGuard.mock.calls[0]?.[0] as
      | { signal?: AbortSignal; timeoutMs?: number }
      | undefined;
    expect(request?.signal).toBe(controller.signal);
    expect(request?.timeoutMs).toEqual(expect.any(Number));
    expect(request?.timeoutMs).toBeGreaterThan(0);
    expect(request?.timeoutMs).toBeLessThanOrEqual(5_000);
    expect(
      (mocks.fetchWithSsrFGuard.mock.calls[0]?.[0] as { policy?: unknown } | undefined)?.policy,
    ).toBe(ssrfPolicy);

    controller.abort("Cancelled by operator.");
    await expect(delivery).rejects.toBeDefined();
    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
  });
});
