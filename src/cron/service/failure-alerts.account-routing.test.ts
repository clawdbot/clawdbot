import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../types.js";
import { resolveFailureAlert } from "./failure-alerts.js";
import { createCronServiceState } from "./state.js";
import { applyJobResult } from "./timer.js";

describe("cron failure alert account routing", () => {
  it.each([
    {
      name: "inherits the primary account when an alert uses its delivery route",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: undefined,
      expected: {
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
      },
    },
    {
      name: "prefers an explicit alert account over the primary account",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: { accountId: "alert-bot" },
      expected: {
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "alert-bot",
      },
    },
    {
      name: "does not inherit the primary account for another channel",
      globalAlert: { enabled: true, after: 1, channel: "slack" },
      jobAlert: undefined,
      expected: { channel: "slack", to: undefined, accountId: undefined },
    },
    {
      name: "does not inherit the primary account for a webhook",
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
        accountId: undefined,
      },
    },
  ])("$name", ({ globalAlert, jobAlert, expected }) => {
    const state = createCronServiceState({
      storePath: "/tmp/openclaw-cron-failure-alert-account-routing.json",
      cronEnabled: true,
      defaultAgentId: "main",
      cronConfig: { failureAlert: globalAlert },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job: CronJob = {
      id: "account-routed-job",
      name: "Account-routed job",
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
        to: "telegram:19098680",
        accountId: "telegram-bot",
      },
      ...(jobAlert ? { failureAlert: jobAlert } : {}),
      state: {},
    };

    expect(resolveFailureAlert(state, job)).toMatchObject(expected);
  });

  it("carries run start time without using it for alert cooldown", () => {
    const runAtMs = Date.parse("2026-07-30T00:00:00.000Z");
    const endedAt = runAtMs + 5 * 60_000;
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createCronServiceState({
      storePath: "/tmp/openclaw-cron-failure-alert-run-time.json",
      cronEnabled: true,
      cronConfig: { failureAlert: { enabled: true, after: 1, cooldownMs: 60_000 } },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowMs: () => endedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      sendCronFailureAlert,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job: CronJob = {
      id: "failed-run",
      name: "Failed run",
      enabled: true,
      createdAtMs: runAtMs,
      updatedAtMs: runAtMs,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "report" },
      delivery: { mode: "announce", channel: "telegram", to: "telegram:19098680" },
      state: {},
    };

    applyJobResult(state, job, {
      status: "error",
      error: "provider unavailable",
      startedAt: runAtMs,
      endedAt,
    });

    expect(sendCronFailureAlert).toHaveBeenCalledWith(expect.objectContaining({ runAtMs }));
    expect(job.state.lastFailureAlertAtMs).toBe(endedAt);
  });
});
