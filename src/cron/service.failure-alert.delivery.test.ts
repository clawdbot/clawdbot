// Cron failure alert delivery-routing tests cover where alerts are delivered:
// global vs per-job destinations, owned failure destinations, and mode/accountId
// threading. Split from service.failure-alert.test.ts to keep files under the
// max-lines cap; alert threshold/text/classification cases stay in the sibling.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import type { CronServiceState } from "./service/state.js";
import { applyJobResult } from "./service/timer.js";

type CronServiceParams = ConstructorParameters<typeof CronService>[0];

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-failure-alert-delivery-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function createFailureAlertCron(params: {
  storePath: string;
  cronConfig?: CronServiceParams["cronConfig"];
  runIsolatedAgentJob: NonNullable<CronServiceParams["runIsolatedAgentJob"]>;
  sendCronFailureAlert: NonNullable<CronServiceParams["sendCronFailureAlert"]>;
}) {
  return new CronService({
    storePath: params.storePath,
    cronEnabled: true,
    cronConfig: params.cronConfig,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: params.runIsolatedAgentJob,
    sendCronFailureAlert: params.sendCronFailureAlert,
  });
}

function alertCallArg(
  sendCronFailureAlert: ReturnType<typeof vi.fn>,
  callIndex = sendCronFailureAlert.mock.calls.length - 1,
): Record<string, unknown> {
  const value = sendCronFailureAlert.mock.calls[callIndex]?.[0];
  if (!value || typeof value !== "object") {
    throw new Error(`expected failure alert call ${callIndex}`);
  }
  return value as Record<string, unknown>;
}

function expectAlertFields(
  sendCronFailureAlert: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
  callIndex?: number,
): Record<string, unknown> {
  const alert = alertCallArg(sendCronFailureAlert, callIndex);
  for (const [key, value] of Object.entries(expected)) {
    expect(alert[key]).toEqual(value);
  }
  return alert;
}

function simulateScheduledRun(
  cron: CronService,
  jobId: string,
  result: {
    status: "error" | "skipped" | "ok";
    error?: string;
    provider?: string;
  },
) {
  const state = (cron as unknown as { state: CronServiceState }).state;
  const job = cron.getJob(jobId);
  if (!job) {
    throw new Error(`job ${jobId} not found`);
  }
  const now = Date.now();
  applyJobResult(state, job, { ...result, startedAt: now, endedAt: now }, { origin: "timer" });
}

function expectAlertTextContaining(
  sendCronFailureAlert: ReturnType<typeof vi.fn>,
  text: string,
  callIndex?: number,
): void {
  const alert = alertCallArg(sendCronFailureAlert, callIndex);
  expect(typeof alert.text).toBe("string");
  if (typeof alert.text !== "string") {
    throw new Error("expected failure alert text");
  }
  expect(alert.text).toContain(text);
}

describe("CronService failure alert delivery routing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("threads failure alert mode/accountId and skips best-effort jobs", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "temporary upstream error",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
          mode: "webhook",
          accountId: "global-account",
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const normalJob = await cron.add({
      name: "normal alert job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });
    const bestEffortJob = await cron.add({
      name: "best effort alert job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "19098680",
        bestEffort: true,
      },
    });

    simulateScheduledRun(cron, normalJob.id, {
      status: "error",
      error: "temporary upstream error",
    });
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expectAlertFields(sendCronFailureAlert, {
      mode: "webhook",
      accountId: "global-account",
      to: undefined,
    });

    simulateScheduledRun(cron, bestEffortJob.id, {
      status: "error",
      error: "temporary upstream error",
    });
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

    cron.stop();
    await store.cleanup();
  });

  it.each([
    {
      name: "uses a globally configured failure webhook destination",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "webhook" as const,
        to: "https://alerts.example.test/cron-failures",
      },
      jobAlert: undefined,
      expected: {
        mode: "webhook",
        to: "https://alerts.example.test/cron-failures",
      },
    },
    {
      name: "uses a globally configured failure announcement channel and target",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "announce" as const,
        channel: "slack",
        to: "slack:cron-alerts",
      },
      jobAlert: undefined,
      expected: {
        mode: "announce",
        channel: "slack",
        to: "slack:cron-alerts",
      },
    },
    {
      name: "preserves an explicit job failure webhook over the global destination",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "webhook" as const,
        to: "https://alerts.example.test/global-failures",
      },
      jobAlert: {
        mode: "webhook" as const,
        to: "https://alerts.example.test/job-failures",
      },
      expected: {
        mode: "webhook",
        to: "https://alerts.example.test/job-failures",
      },
    },
    {
      name: "never reuses a global webhook URL as an overridden job chat target",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "webhook" as const,
        to: "https://alerts.example.test/global-failures",
      },
      jobAlert: {
        mode: "announce" as const,
      },
      expected: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:19098680",
      },
    },
    {
      name: "never reuses a global chat target after a job changes the failure channel",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "announce" as const,
        channel: "slack",
        to: "slack:cron-alerts",
      },
      jobAlert: {
        mode: "announce" as const,
        channel: "telegram",
      },
      expected: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:19098680",
      },
    },
    {
      name: "never reuses a global webhook channel after a job switches to chat",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "webhook" as const,
        channel: "slack",
        to: "https://alerts.example.test/global-failures",
      },
      jobAlert: {
        mode: "announce" as const,
      },
      expected: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:19098680",
      },
    },
    {
      name: "never reuses a job chat target for a global channel-only alert",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "announce" as const,
        channel: "slack",
      },
      jobAlert: undefined,
      expected: {
        mode: "announce",
        channel: "slack",
        to: undefined,
      },
    },
    {
      name: "preserves a global webhook URL when an unused job channel is set",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "webhook" as const,
        to: "https://alerts.example.test/global-failures",
      },
      jobAlert: {
        channel: "telegram",
      },
      expected: {
        mode: "webhook",
        to: "https://alerts.example.test/global-failures",
      },
    },
  ])("$name", async ({ globalAlert, jobAlert, expected }) => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: { failureAlert: globalAlert },
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "error" as const,
        error: "temporary upstream error",
      })),
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "globally routed failure alert",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:19098680",
      },
      ...(jobAlert ? { failureAlert: jobAlert } : {}),
    });

    await cron.run(job.id, "force");

    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
    expectAlertFields(sendCronFailureAlert, expected);
    expectAlertTextContaining(
      sendCronFailureAlert,
      'Cron job "globally routed failure alert" failed 1 times',
    );

    cron.stop();
    await store.cleanup();
  });

  it.each([
    {
      name: "channel-shaped failure destination",
      failureDestination: { channel: "slack", to: "#alerts" },
    },
    {
      name: "webhook failure destination",
      failureDestination: {
        mode: "webhook" as const,
        to: "https://alerts.example.test/job-failures",
      },
    },
    {
      name: "clear-only failure destination opt-out",
      failureDestination: {
        channel: undefined,
        to: undefined,
        accountId: undefined,
        mode: undefined,
      },
    },
  ])("does not duplicate an explicitly owned $name", async ({ failureDestination }) => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
          mode: "webhook",
          to: "https://alerts.example.test/global-failures",
        },
      },
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "error" as const,
        error: "temporary upstream error",
      })),
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "explicitly routed failure destination",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: { mode: "none", failureDestination },
    });

    expect(job.delivery?.failureDestination).toBeDefined();
    await cron.run(job.id, "force");

    expect(sendCronFailureAlert).not.toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });

  it("preserves explicit job alerts alongside an owned failure destination", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
          mode: "webhook",
          to: "https://alerts.example.test/global-failures",
        },
      },
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "error" as const,
        error: "temporary upstream error",
      })),
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "explicit job alert with a failure destination",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: {
        mode: "none",
        failureDestination: { channel: "slack", to: "#alerts" },
      },
      failureAlert: {
        after: 1,
        mode: "announce",
        channel: "telegram",
        to: "telegram:19098680",
      },
    });

    await cron.run(job.id, "force");

    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
    expectAlertFields(sendCronFailureAlert, {
      mode: "announce",
      channel: "telegram",
      to: "telegram:19098680",
    });
    expectAlertTextContaining(
      sendCronFailureAlert,
      'Cron job "explicit job alert with a failure destination" failed 1 times',
    );

    cron.stop();
    await store.cleanup();
  });

  it("preserves global skipped alerts alongside an owned failure destination", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
          includeSkipped: true,
          mode: "announce",
          channel: "telegram",
          to: "telegram:19098680",
        },
      },
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "skipped" as const,
        error: "requests-in-flight",
      })),
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "skipped job with a failure destination",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: {
        mode: "none",
        failureDestination: { channel: "slack", to: "#alerts" },
      },
    });

    // Skip alerts run off the scheduler-owned skip counter, so drive a scheduled
    // skip: an operator force run is non-consuming and leaves consecutiveSkipped
    // untouched (#83538/#83933). The owned failure destination suppresses error
    // alerts only, so the global skip alert must still fire here.
    simulateScheduledRun(cron, job.id, {
      status: "skipped",
      error: "requests-in-flight",
    });

    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
    expectAlertFields(sendCronFailureAlert, {
      mode: "announce",
      channel: "telegram",
      to: "telegram:19098680",
    });
    expectAlertTextContaining(
      sendCronFailureAlert,
      'Cron job "skipped job with a failure destination" skipped 1 times',
    );

    cron.stop();
    await store.cleanup();
  });
});
