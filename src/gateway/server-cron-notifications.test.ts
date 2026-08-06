// Cron notification tests protect completion-delivery warning behavior,
// including URL redaction for invalid webhook destinations.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import type { CronJob } from "../cron/types.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(async (_request: unknown) => ({
    response: new Response(null, { status: 204 }),
    finalUrl: "https://example.invalid/cron",
    release: vi.fn(async () => {}),
  })),
  sendFailureNotificationAnnounce: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

vi.mock("../cron/delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cron/delivery.js")>();
  return {
    ...actual,
    sendFailureNotificationAnnounce: mocks.sendFailureNotificationAnnounce,
  };
});

import { dispatchGatewayCronFinishedNotifications } from "./server-cron-notifications.js";

describe("dispatchGatewayCronFinishedNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redacts invalid completion webhook targets in warnings", () => {
    const logger = {
      warn: vi.fn(),
    };
    const job = {
      id: "cron-redact",
      name: "redact",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: {
        mode: "announce",
        completionDestination: {
          mode: "webhook",
          to: "ftp://user:secret@example.invalid/hook?token=secret",
        },
      },
      state: {},
    } satisfies CronJob;

    dispatchGatewayCronFinishedNotifications({
      evt: { jobId: job.id, action: "finished", status: "ok" },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      {
        jobId: "cron-redact",
        deliveryTo: "ftp://example.invalid/hook",
      },
      "cron: skipped completion webhook delivery, delivery.completionDestination.to must be a valid http(s) URL",
    );
  });

  it("keeps configured failure destinations from inheriting the primary delivery thread", () => {
    const logger = {
      warn: vi.fn(),
    };
    const job = {
      id: "cron-threaded-failure-dest",
      name: "threaded failure dest",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      sessionKey: "agent:main:telegram:group:-1001234567890:thread:42",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "-1001234567890",
        threadId: 42,
        failureDestination: {
          mode: "announce",
          channel: "telegram",
          to: "-1001234567890",
        },
      },
      state: {},
    } satisfies CronJob;

    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: job.id,
        action: "finished",
        status: "error",
        error: "boom",
      },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    expect(mocks.sendFailureNotificationAnnounce).toHaveBeenCalledTimes(1);
    expect(mocks.sendFailureNotificationAnnounce.mock.calls[0]?.[4]).toEqual({
      channel: "telegram",
      to: "-1001234567890",
      accountId: undefined,
      sessionKey: "agent:main:telegram:group:-1001234567890:thread:42",
      inheritSessionThread: false,
    });
  });

  it("announces channel-shaped failure destinations without mode under a global webhook default (#102235)", () => {
    const logger = { warn: vi.fn() };
    const job = makeCronJob({
      id: "cron-channel-fd-no-mode",
      name: "channel fd no mode",
      delivery: {
        mode: "none",
        failureDestination: { channel: "slack", to: "#alerts" },
      },
    });

    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: job.id,
        action: "finished",
        status: "error",
        error: "boom",
      },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
      globalFailureDestination: {
        mode: "webhook",
        to: "https://hook.example/cron",
      },
    });

    expect(mocks.sendFailureNotificationAnnounce).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "main",
      job.id,
      {
        channel: "slack",
        to: "#alerts",
        accountId: undefined,
        sessionKey: undefined,
        inheritSessionThread: false,
      },
      '⚠️ Cron job "channel fd no mode" failed: boom',
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id }),
      "cron: failure destination webhook URL is invalid, skipping",
    );
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});
