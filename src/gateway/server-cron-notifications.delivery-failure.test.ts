import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import type { CronJob } from "../cron/types.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";

const sendFailureNotificationAnnounce = vi.hoisted(() => vi.fn());

vi.mock("../cron/delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cron/delivery.js")>();
  return { ...actual, sendFailureNotificationAnnounce };
});

import { dispatchGatewayCronFinishedNotifications } from "./server-cron-notifications.js";

function createThreadedJob(withFailureDestination: boolean, bestEffort?: boolean): CronJob {
  return {
    id: "cron-delivery-failure",
    name: "threaded report",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "report" },
    delivery: {
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890",
      threadId: 42,
      ...(bestEffort === undefined ? {} : { bestEffort }),
      ...(withFailureDestination
        ? {
            failureDestination: {
              mode: "announce" as const,
              channel: "telegram" as const,
              to: "-1001234567890",
            },
          }
        : {}),
    },
    state: {},
  };
}

describe("cron primary delivery failure notifications", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    sendFailureNotificationAnnounce.mockReset();
    sendFailureNotificationAnnounce.mockResolvedValue(undefined);
  });

  afterEach(() => resetGatewayWorkAdmission());

  it("uses only an explicit failure destination", () => {
    const evt = {
      jobId: "cron-delivery-failure",
      action: "finished" as const,
      status: "ok" as const,
      completionStatus: "failed" as const,
      deliveryStatus: "not-delivered" as const,
      deliveryError: "message thread not found",
    };
    const dispatch = (job: CronJob) =>
      dispatchGatewayCronFinishedNotifications({
        evt,
        job,
        deps: {} as CliDeps,
        logger: { warn: vi.fn() },
        resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
      });

    dispatch(createThreadedJob(false));
    expect(sendFailureNotificationAnnounce).not.toHaveBeenCalled();

    dispatch(createThreadedJob(true));
    expect(sendFailureNotificationAnnounce).toHaveBeenCalledOnce();
    expect(sendFailureNotificationAnnounce.mock.calls[0]?.[4]).toEqual({
      channel: "telegram",
      to: "-1001234567890",
      accountId: undefined,
      sessionKey: undefined,
      inheritSessionThread: false,
    });
    expect(sendFailureNotificationAnnounce.mock.calls[0]?.[5]).toEqual({
      text:
        '⚠️ Automation "threaded report" delivery failed\n' +
        "Check automation history for details.",
    });
  });

  it.each([
    { completionStatus: "failed" as const, currentBestEffort: true, expected: 1 },
    { completionStatus: "succeeded" as const, currentBestEffort: false, expected: 0 },
  ])(
    "uses event completion $completionStatus after the current policy changes",
    ({ completionStatus, currentBestEffort, expected }) => {
      dispatchGatewayCronFinishedNotifications({
        evt: {
          jobId: "cron-delivery-failure",
          action: "finished",
          status: "ok",
          completionStatus,
          deliveryStatus: "not-delivered",
          deliveryError: "message thread not found",
        },
        job: createThreadedJob(true, currentBestEffort),
        deps: {} as CliDeps,
        logger: { warn: vi.fn() },
        resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
      });

      expect(sendFailureNotificationAnnounce).toHaveBeenCalledTimes(expected);
    },
  );

  it("keeps configured failure destinations from inheriting the primary delivery thread", () => {
    const job = createThreadedJob(true);
    job.sessionKey = "agent:main:telegram:group:-1001234567890:thread:42";

    dispatchGatewayCronFinishedNotifications({
      evt: { jobId: job.id, action: "finished", status: "error", error: "boom" },
      job,
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    expect(sendFailureNotificationAnnounce).toHaveBeenCalledTimes(1);
    expect(sendFailureNotificationAnnounce.mock.calls[0]?.[4]).toEqual({
      channel: "telegram",
      to: "-1001234567890",
      accountId: undefined,
      sessionKey: "agent:main:telegram:group:-1001234567890:thread:42",
      inheritSessionThread: false,
    });
  });
});
