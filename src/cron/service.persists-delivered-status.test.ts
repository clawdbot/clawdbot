import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createFinishedBarrier,
  createStartedCronServiceWithFinishedBarrier,
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

type CronAddInput = Parameters<CronService["add"]>[0];

function buildIsolatedAgentTurnJob(name: string): CronAddInput {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
  };
}

function buildAnnounceIsolatedAgentTurnJob(name: string): CronAddInput {
  return {
    ...buildIsolatedAgentTurnJob(name),
    delivery: { mode: "announce", channel: "forum", to: "123" },
  };
}

function buildAnnounceWithFailureDestinationJob(name: string): CronAddInput {
  return {
    ...buildAnnounceIsolatedAgentTurnJob(name),
    delivery: {
      mode: "announce",
      channel: "forum",
      to: "123",
      failureDestination: {
        mode: "webhook",
        to: "https://example.invalid/cron-failure",
      },
    },
  };
}

function buildFailureDestinationOnlyJob(name: string): CronAddInput {
  return {
    ...buildIsolatedAgentTurnJob(name),
    delivery: {
      mode: "none",
      failureDestination: {
        mode: "webhook",
        to: "https://example.invalid/cron-failure",
      },
    },
  };
}

function buildBestEffortFailureDestinationOnlyJob(name: string): CronAddInput {
  return {
    ...buildFailureDestinationOnlyJob(name),
    delivery: {
      mode: "none",
      bestEffort: true,
      failureDestination: {
        mode: "webhook",
        to: "https://example.invalid/cron-failure",
      },
    },
  };
}

function buildMainSessionSystemEventJob(name: string): CronAddInput {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "tick" },
  };
}

function createIsolatedCronWithFinishedBarrier(params: {
  storePath: string;
  status?: "ok" | "error";
  delivered?: boolean;
  error?: string;
  onFinished?: (evt: {
    jobId: string;
    delivered?: boolean;
    deliveryStatus?: string;
    failureNotificationDelivery?: {
      delivered?: boolean;
      status: string;
      error?: string;
    };
  }) => void;
}) {
  const finished = createFinishedBarrier();
  const cron = new CronService({
    storePath: params.storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({
      status: params.status ?? ("ok" as const),
      summary: "done",
      ...(params.error === undefined ? {} : { error: params.error }),
      ...(params.delivered === undefined ? {} : { delivered: params.delivered }),
    })),
    onEvent: (evt) => {
      if (evt.action === "finished") {
        params.onFinished?.({
          jobId: evt.jobId,
          delivered: evt.delivered,
          deliveryStatus: evt.deliveryStatus,
          failureNotificationDelivery: evt.failureNotificationDelivery,
        });
      }
      finished.onEvent(evt);
    },
  });
  return { cron, finished };
}

async function runSingleJobAndReadState(params: {
  cron: CronService;
  finished: ReturnType<typeof createFinishedBarrier>;
  job: CronAddInput;
  waitForFinished?: (jobId: string) => Promise<unknown>;
}) {
  const job = await params.cron.add(params.job);
  const finishedPromise = params.waitForFinished?.(job.id) ?? params.finished.waitForOk(job.id);
  vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
  await vi.runOnlyPendingTimersAsync();
  await finishedPromise;

  const jobs = await params.cron.list({ includeDisabled: true });
  return { job, updated: jobs.find((entry) => entry.id === job.id) };
}

function expectSuccessfulCronRun(
  updated:
    | {
        state: {
          lastStatus?: string;
          lastRunStatus?: string;
          [key: string]: unknown;
        };
      }
    | undefined,
) {
  expect(updated?.state.lastStatus).toBe("ok");
  expect(updated?.state.lastRunStatus).toBe("ok");
}

function expectDeliveryNotRequested(
  updated:
    | {
        state: {
          lastDelivered?: boolean;
          lastDeliveryStatus?: string;
          lastDeliveryError?: string;
          lastFailureNotificationDelivered?: boolean;
          lastFailureNotificationDeliveryStatus?: string;
          lastFailureNotificationDeliveryError?: string;
        };
      }
    | undefined,
) {
  expectSuccessfulCronRun(updated);
  expect(updated?.state.lastDelivered).toBeUndefined();
  expect(updated?.state.lastDeliveryStatus).toBe("not-requested");
  expect(updated?.state.lastDeliveryError).toBeUndefined();
  expect(updated?.state.lastFailureNotificationDelivered).toBeUndefined();
  expect(updated?.state.lastFailureNotificationDeliveryStatus).toBe("not-requested");
  expect(updated?.state.lastFailureNotificationDeliveryError).toBeUndefined();
}

async function runIsolatedJobAndReadState(params: {
  job: CronAddInput;
  status?: "ok" | "error";
  delivered?: boolean;
  error?: string;
  onFinished?: (evt: {
    jobId: string;
    delivered?: boolean;
    deliveryStatus?: string;
    failureNotificationDelivery?: {
      delivered?: boolean;
      status: string;
      error?: string;
    };
  }) => void;
}) {
  const store = await makeStorePath();
  const finishedEvents = new Map<string, (evt: unknown) => void>();
  const { cron, finished } = createIsolatedCronWithFinishedBarrier({
    storePath: store.storePath,
    ...(params.status !== undefined ? { status: params.status } : {}),
    ...(params.delivered !== undefined ? { delivered: params.delivered } : {}),
    ...(params.error !== undefined ? { error: params.error } : {}),
    onFinished: (evt) => {
      params.onFinished?.(evt);
      finishedEvents.get(evt.jobId)?.(evt);
    },
  });

  await cron.start();
  try {
    const { updated } = await runSingleJobAndReadState({
      cron,
      finished,
      job: params.job,
      waitForFinished: (jobId) =>
        new Promise((resolve) => {
          finishedEvents.set(jobId, resolve);
        }),
    });
    return updated;
  } finally {
    cron.stop();
  }
}

describe("CronService persists delivered status", () => {
  it("persists lastDelivered=true when isolated job reports delivered", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildAnnounceIsolatedAgentTurnJob("delivered-true"),
      delivered: true,
    });
    expectSuccessfulCronRun(updated);
    expect(updated?.state.lastDelivered).toBe(true);
    expect(updated?.state.lastDeliveryStatus).toBe("delivered");
    expect(updated?.state.lastDeliveryError).toBeUndefined();
    expect(updated?.state.lastFailureNotificationDelivered).toBeUndefined();
    expect(updated?.state.lastFailureNotificationDeliveryStatus).toBe("not-requested");
  });

  it("persists lastDelivered=false when isolated job explicitly reports not delivered", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildAnnounceIsolatedAgentTurnJob("delivered-false"),
      delivered: false,
    });
    expectSuccessfulCronRun(updated);
    expect(updated?.state.lastDelivered).toBe(false);
    expect(updated?.state.lastDeliveryStatus).toBe("not-delivered");
    expect(updated?.state.lastDeliveryError).toBeUndefined();
    expect(updated?.state.lastFailureNotificationDelivered).toBeUndefined();
    expect(updated?.state.lastFailureNotificationDeliveryStatus).toBe("not-requested");
  });

  it("keeps failure notification delivery separate from successful result delivery", async () => {
    let capturedEvent:
      | {
          delivered?: boolean;
          deliveryStatus?: string;
          failureNotificationDelivery?: {
            delivered?: boolean;
            status: string;
            error?: string;
          };
        }
      | undefined;
    const updated = await runIsolatedJobAndReadState({
      job: buildAnnounceIsolatedAgentTurnJob("error-notification-delivered"),
      status: "error",
      delivered: true,
      error: "Agent couldn't generate a response.",
      onFinished: (evt) => {
        capturedEvent = evt;
      },
    });

    expect(updated?.state.lastRunStatus).toBe("error");
    expect(updated?.state.lastDelivered).toBe(false);
    expect(updated?.state.lastDeliveryStatus).toBe("not-delivered");
    expect(updated?.state.lastDeliveryError).toBe("Agent couldn't generate a response.");
    expect(updated?.state.lastFailureNotificationDelivered).toBe(true);
    expect(updated?.state.lastFailureNotificationDeliveryStatus).toBe("delivered");
    expect(updated?.state.lastFailureNotificationDeliveryError).toBeUndefined();
    expect(capturedEvent?.delivered).toBe(false);
    expect(capturedEvent?.deliveryStatus).toBe("not-delivered");
    expect(capturedEvent?.failureNotificationDelivery).toEqual({
      delivered: true,
      status: "delivered",
    });
  });

  it("marks failure-destination-only error notification delivery unknown", async () => {
    let capturedEvent:
      | {
          delivered?: boolean;
          deliveryStatus?: string;
          failureNotificationDelivery?: {
            delivered?: boolean;
            status: string;
            error?: string;
          };
        }
      | undefined;
    const updated = await runIsolatedJobAndReadState({
      job: buildFailureDestinationOnlyJob("failure-destination-only"),
      status: "error",
      error: "Agent couldn't generate a response.",
      onFinished: (evt) => {
        capturedEvent = evt;
      },
    });

    expect(updated?.state.lastRunStatus).toBe("error");
    expect(updated?.state.lastDelivered).toBeUndefined();
    expect(updated?.state.lastDeliveryStatus).toBe("not-requested");
    expect(updated?.state.lastFailureNotificationDelivered).toBeUndefined();
    expect(updated?.state.lastFailureNotificationDeliveryStatus).toBe("unknown");
    expect(capturedEvent?.delivered).toBeUndefined();
    expect(capturedEvent?.deliveryStatus).toBe("not-requested");
    expect(capturedEvent?.failureNotificationDelivery).toEqual({ status: "unknown" });
  });

  it("does not treat primary error delivery as alternate failure-destination delivery", async () => {
    let capturedEvent:
      | {
          delivered?: boolean;
          deliveryStatus?: string;
          failureNotificationDelivery?: {
            delivered?: boolean;
            status: string;
            error?: string;
          };
        }
      | undefined;
    const updated = await runIsolatedJobAndReadState({
      job: buildAnnounceWithFailureDestinationJob("announce-plus-failure-destination"),
      status: "error",
      delivered: true,
      error: "Agent couldn't generate a response.",
      onFinished: (evt) => {
        capturedEvent = evt;
      },
    });

    expect(updated?.state.lastRunStatus).toBe("error");
    expect(updated?.state.lastDelivered).toBe(false);
    expect(updated?.state.lastDeliveryStatus).toBe("not-delivered");
    expect(updated?.state.lastFailureNotificationDelivered).toBeUndefined();
    expect(updated?.state.lastFailureNotificationDeliveryStatus).toBe("unknown");
    expect(capturedEvent?.delivered).toBe(false);
    expect(capturedEvent?.failureNotificationDelivery).toEqual({ status: "unknown" });
  });

  it("keeps best-effort failure destinations suppressed", async () => {
    let capturedEvent:
      | {
          delivered?: boolean;
          deliveryStatus?: string;
          failureNotificationDelivery?: {
            delivered?: boolean;
            status: string;
            error?: string;
          };
        }
      | undefined;
    const updated = await runIsolatedJobAndReadState({
      job: buildBestEffortFailureDestinationOnlyJob("best-effort-failure-destination-only"),
      status: "error",
      error: "Agent couldn't generate a response.",
      onFinished: (evt) => {
        capturedEvent = evt;
      },
    });

    expect(updated?.state.lastRunStatus).toBe("error");
    expect(updated?.state.lastDeliveryStatus).toBe("not-requested");
    expect(updated?.state.lastFailureNotificationDelivered).toBeUndefined();
    expect(updated?.state.lastFailureNotificationDeliveryStatus).toBe("not-requested");
    expect(capturedEvent?.deliveryStatus).toBe("not-requested");
    expect(capturedEvent?.failureNotificationDelivery).toBeUndefined();
  });

  it("suppresses delivered=false when delivery.mode none opts out of delivery", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildIsolatedAgentTurnJob("delivery-none-delivered-false"),
      delivered: false,
      error: "Message failed",
    });
    expectDeliveryNotRequested(updated);
  });

  it("preserves delivery errors when requested delivery reports not delivered", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildAnnounceIsolatedAgentTurnJob("delivery-requested-error"),
      delivered: false,
      error: "Message failed",
    });
    expectSuccessfulCronRun(updated);
    expect(updated?.state.lastDelivered).toBe(false);
    expect(updated?.state.lastDeliveryStatus).toBe("not-delivered");
    expect(updated?.state.lastDeliveryError).toBe("Message failed");
  });

  it("persists not-requested delivery state when delivery is not configured", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildIsolatedAgentTurnJob("no-delivery"),
    });
    expectDeliveryNotRequested(updated);
  });

  it("persists unknown delivery state when delivery is requested but the runner omits delivered", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildAnnounceIsolatedAgentTurnJob("delivery-unknown"),
    });
    expectSuccessfulCronRun(updated);
    expect(updated?.state.lastDelivered).toBeUndefined();
    expect(updated?.state.lastDeliveryStatus).toBe("unknown");
    expect(updated?.state.lastDeliveryError).toBeUndefined();
  });

  it("does not set lastDelivered for main session jobs", async () => {
    const store = await makeStorePath();
    const { cron, enqueueSystemEvent, finished } = createStartedCronServiceWithFinishedBarrier({
      storePath: store.storePath,
      logger: noopLogger,
    });

    await cron.start();
    const { updated } = await runSingleJobAndReadState({
      cron,
      finished,
      job: buildMainSessionSystemEventJob("main-session"),
    });

    expectDeliveryNotRequested(updated);
    expect(enqueueSystemEvent).toHaveBeenCalled();

    cron.stop();
  });

  it("emits delivered in the finished event", async () => {
    let capturedEvent: { jobId: string; delivered?: boolean; deliveryStatus?: string } | undefined;
    await runIsolatedJobAndReadState({
      job: buildAnnounceIsolatedAgentTurnJob("event-test"),
      delivered: true,
      onFinished: (evt) => {
        capturedEvent = evt;
      },
    });

    expect(capturedEvent?.delivered).toBe(true);
    expect(capturedEvent?.deliveryStatus).toBe("delivered");
  });
});
