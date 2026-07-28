// Cron failure alert tests cover notification behavior for failed scheduled jobs.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

type CronServiceParams = ConstructorParameters<typeof CronService>[0];

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-failure-alert-"));
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

describe("CronService failure alerts", () => {
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

  it("alerts after configured consecutive failures and honors cooldown", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "wrong model id",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 2,
          cooldownMs: 60_000,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "daily report",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).not.toHaveBeenCalled();

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    const firstAlert = expectAlertFields(sendCronFailureAlert, {
      channel: "telegram",
      to: "19098680",
    });
    expect((firstAlert.job as { id?: string } | undefined)?.id).toBe(job.id);
    expectAlertTextContaining(sendCronFailureAlert, 'Cron job "daily report" failed 2 times');

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
    expectAlertTextContaining(sendCronFailureAlert, 'Cron job "daily report" failed 4 times');

    cron.stop();
    await store.cleanup();
  });

  it("supports per-job failure alert override when global alerts are disabled", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "timeout",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: false,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "job with override",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      failureAlert: {
        after: 1,
        channel: "telegram",
        to: "12345",
        cooldownMs: 1,
      },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expectAlertFields(sendCronFailureAlert, {
      channel: "telegram",
      to: "12345",
    });

    cron.stop();
    await store.cleanup();
  });

  it("respects per-job failureAlert=false and suppresses alerts", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "auth error",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "disabled alert job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      failureAlert: false,
    });

    await cron.run(job.id, "force");
    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).not.toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });

  it("preserves includeSkipped through failure alert updates", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "skipped" as const,
      error: "requests-in-flight",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "updated skipped alert job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      failureAlert: {
        after: 1,
        channel: "telegram",
        to: "12345",
      },
    });

    const updated = await cron.update(job.id, {
      failureAlert: {
        includeSkipped: true,
      },
    });
    const updatedFailureAlert = updated?.failureAlert;
    if (!updatedFailureAlert) {
      throw new Error("expected updated failure alert config");
    }
    expect(updatedFailureAlert.after).toBe(1);
    expect(updatedFailureAlert.channel).toBe("telegram");
    expect(updatedFailureAlert.to).toBe("12345");
    expect(updatedFailureAlert.includeSkipped).toBe(true);

    await cron.run(job.id, "force");
    expectAlertFields(sendCronFailureAlert, {
      channel: "telegram",
      to: "12345",
    });
    expectAlertTextContaining(
      sendCronFailureAlert,
      'Cron job "updated skipped alert job" skipped 1 times',
    );

    cron.stop();
    await store.cleanup();
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

    await cron.run(normalJob.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expectAlertFields(sendCronFailureAlert, {
      mode: "webhook",
      accountId: "global-account",
      to: undefined,
    });

    await cron.run(bestEffortJob.id, "force");
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
        accountId: "slack-bot",
      },
      jobAlert: undefined,
      expected: {
        mode: "announce",
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
      },
    },
    {
      name: "preserves a global route when a job explicitly repeats its alert mode",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "announce" as const,
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
      },
      jobAlert: {
        mode: "announce" as const,
      },
      expected: {
        mode: "announce",
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
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
        accountId: "slack-bot",
      },
      jobAlert: {
        mode: "announce" as const,
        channel: "telegram",
      },
      expected: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:19098680",
        accountId: undefined,
      },
    },
    {
      name: "never reuses a global chat target or account for the last failure channel",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "announce" as const,
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
      },
      jobAlert: {
        mode: "announce" as const,
        channel: "last",
      },
      expected: {
        mode: "announce",
        channel: "last",
        to: undefined,
        accountId: undefined,
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

    await cron.run(job.id, "force");

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

  it("alerts for repeated skipped runs only when opted in", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "skipped" as const,
      error: "disabled",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 2,
          cooldownMs: 60_000,
          includeSkipped: true,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "gateway restart",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "restart gateway if needed" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).not.toHaveBeenCalled();

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expectAlertFields(sendCronFailureAlert, {
      channel: "telegram",
      to: "19098680",
    });
    const alertText = alertCallArg(sendCronFailureAlert).text;
    expect(typeof alertText).toBe("string");
    if (typeof alertText !== "string") {
      throw new Error("expected failure alert text");
    }
    expect(alertText).toMatch(/Cron job "gateway restart" skipped 2 times\nSkip reason: disabled/);

    const skippedJob = cron.getJob(job.id);
    expect(skippedJob?.state.consecutiveSkipped).toBe(2);
    expect(skippedJob?.state.consecutiveErrors).toBe(0);

    cron.stop();
    await store.cleanup();
  });

  it("surfaces classified causes before raw errors in failure alerts", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "cron: job execution timed out",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "timeout cause alert",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "ping" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    const alertText = alertCallArg(sendCronFailureAlert).text;
    expect(alertText).toBe(
      'Cron job "timeout cause alert" failed 1 times\n' +
        "Cause: timeout\n" +
        "Last error: cron: job execution timed out",
    );

    cron.stop();
    await store.cleanup();
  });

  it("uses provider context when surfacing failure alert causes", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "403 Key limit exceeded (monthly limit)",
      provider: "openrouter",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "provider limit alert",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "ping" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    const alertText = alertCallArg(sendCronFailureAlert).text;
    expect(alertText).toBe(
      'Cron job "provider limit alert" failed 1 times\n' +
        "Cause: billing\n" +
        "Last error: 403 Key limit exceeded (monthly limit)",
    );

    cron.stop();
    await store.cleanup();
  });

  it("does not reclassify permanent local script errors in failure alerts", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "cron script failed after a tool side effect: request timed out",
      errorClassification: { kind: "permanent" as const },
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "permanent script alert",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "ping" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(alertCallArg(sendCronFailureAlert).text).toBe(
      'Cron job "permanent script alert" failed 1 times\n' +
        "Last error: cron script failed after a tool side effect: request timed out",
    );

    cron.stop();
    await store.cleanup();
  });

  it("keeps skipped alert text unchanged when the skip reason looks classifiable", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "skipped" as const,
      error: "cron: job execution timed out",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
          includeSkipped: true,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "skipped timeout",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "ping" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    const alertText = alertCallArg(sendCronFailureAlert).text;
    expect(alertText).toBe(
      'Cron job "skipped timeout" skipped 1 times\nSkip reason: cron: job execution timed out',
    );

    cron.stop();
    await store.cleanup();
  });

  it("tracks skipped runs without alerting or affecting error backoff when includeSkipped is off", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "skipped" as const,
      error: "requests-in-flight",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "busy heartbeat",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });

    await cron.run(job.id, "force");
    await cron.run(job.id, "force");

    expect(sendCronFailureAlert).not.toHaveBeenCalled();
    const skippedJob = cron.getJob(job.id);
    expect(skippedJob?.state.consecutiveSkipped).toBe(2);
    expect(skippedJob?.state.consecutiveErrors).toBe(0);

    cron.stop();
    await store.cleanup();
  });

  it("truncates failure alert error text on UTF-16 code-point boundary", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    // 209 code units: emoji (surrogate pair) at positions 199-200 straddles the 200-unit boundary
    const longError = `${"x".repeat(199)}🎉trailing`;
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: longError,
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: { failureAlert: { enabled: true, after: 1 } },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "utf16 boundary job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "ping" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    const alertText = alertCallArg(sendCronFailureAlert).text;
    expect(typeof alertText).toBe("string");
    if (typeof alertText !== "string") {
      throw new Error("expected failure alert text");
    }

    // Verify no dangling surrogates in the truncated error text.
    // Must check every character including the last: a dangling high surrogate
    // at the final position would be missed by stopping at length-1.
    for (let i = 0; i < alertText.length; i++) {
      const cu = alertText.charCodeAt(i);
      if (cu >= 0xd800 && cu <= 0xdbff) {
        expect(alertText.charCodeAt(i + 1) >= 0xdc00 && alertText.charCodeAt(i + 1) <= 0xdfff).toBe(
          true,
        );
      }
      if (cu >= 0xdc00 && cu <= 0xdfff) {
        expect(
          i > 0 && alertText.charCodeAt(i - 1) >= 0xd800 && alertText.charCodeAt(i - 1) <= 0xdbff,
        ).toBe(true);
      }
    }

    // Verify the emoji was excluded (truncated at the safe boundary before it)
    expect(alertText).not.toContain("🎉");

    cron.stop();
    await store.cleanup();
  });
});
