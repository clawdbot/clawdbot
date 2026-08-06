import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { CronJob } from "../types.js";
import { resolveFailureAlert } from "./failure-alerts.js";
import { createCronServiceState, type DeferredCronNotifications } from "./state.js";
import { applyJobResult } from "./timer.js";

describe("cron failure alert account routing", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry(
        [
          { id: "telegram", aliases: [], targetPrefixes: ["telegram", "tg"] },
          {
            id: "googlechat",
            aliases: ["gchat", "google-chat"],
            targetPrefixes: ["googlechat", "google-chat", "gchat"],
          },
        ].map(({ id, aliases, targetPrefixes }) => {
          const plugin = createChannelTestPluginBase({ id });
          return {
            pluginId: id,
            plugin: {
              ...plugin,
              meta: { ...plugin.meta, aliases },
              messaging: { targetPrefixes },
            },
            source: `test:${id}`,
          };
        }),
      ),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it.each([
    {
      name: "inherits the primary account when an alert uses its delivery route",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: undefined,
      expected: {
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
        threadId: 42,
      },
    },
    {
      name: "inherits the primary account and topic when an alert repeats its recipient",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: { to: "telegram:19098680" },
      expected: {
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
        threadId: 42,
      },
    },
    {
      name: "inherits the primary account and topic through a provider target alias",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: { to: "tg:19098680" },
      expected: {
        channel: "telegram",
        to: "tg:19098680",
        accountId: "telegram-bot",
        threadId: 42,
      },
    },
    {
      name: "inherits the primary account and topic when delivery uses the target alias",
      globalAlert: { enabled: true, after: 1 },
      deliveryTo: "tg:19098680",
      jobAlert: { to: "telegram:19098680" },
      expected: {
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
        threadId: 42,
      },
    },
    {
      name: "normalizes provider alias case and surrounding recipient whitespace",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: { to: "  TG: 19098680  " },
      expected: {
        channel: "telegram",
        to: "TG: 19098680",
        accountId: "telegram-bot",
        threadId: 42,
      },
    },
    {
      name: "inherits the primary account and topic through a selected channel alias",
      globalAlert: { enabled: true, after: 1 },
      deliveryChannel: "gchat",
      deliveryTo: "gchat:RoomA",
      jobAlert: { channel: "gchat", to: "googlechat:RoomA" },
      expected: {
        channel: "googlechat",
        to: "googlechat:RoomA",
        accountId: "telegram-bot",
        threadId: 42,
      },
    },
    {
      name: "inherits the primary account and topic when the alert selects a channel alias",
      globalAlert: { enabled: true, after: 1 },
      deliveryChannel: "googlechat",
      deliveryTo: "googlechat:RoomA",
      jobAlert: { channel: "gchat", to: "googlechat:RoomA" },
      expected: {
        channel: "googlechat",
        to: "googlechat:RoomA",
        accountId: "telegram-bot",
        threadId: 42,
      },
    },
    {
      name: "inherits the primary account and topic when delivery selects a channel alias",
      globalAlert: { enabled: true, after: 1 },
      deliveryChannel: "gchat",
      deliveryTo: "gchat:RoomA",
      jobAlert: { channel: "googlechat", to: "googlechat:RoomA" },
      expected: {
        channel: "googlechat",
        to: "googlechat:RoomA",
        accountId: "telegram-bot",
        threadId: 42,
      },
    },
    {
      name: "does not equate case-sensitive recipient identities across provider aliases",
      globalAlert: { enabled: true, after: 1 },
      deliveryChannel: "googlechat",
      deliveryTo: "googlechat:RoomA",
      jobAlert: { to: "gchat:rooma" },
      expected: {
        channel: "googlechat",
        to: "gchat:rooma",
        accountId: undefined,
        threadId: undefined,
      },
    },
    {
      name: "does not equate a provider alias targeting another topic",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: { to: "tg:19098680:topic:99" },
      expected: {
        channel: "telegram",
        to: "tg:19098680:topic:99",
        accountId: undefined,
        threadId: undefined,
      },
    },
    {
      name: "does not inherit the primary account or topic for another recipient",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: { to: "telegram:19098681" },
      expected: {
        channel: "telegram",
        to: "telegram:19098681",
        accountId: undefined,
        threadId: undefined,
      },
    },
    {
      name: "does not inherit the primary topic when an aliased recipient uses another account",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: { to: "tg:19098680", accountId: "alert-bot" },
      expected: {
        channel: "telegram",
        to: "tg:19098680",
        accountId: "alert-bot",
        threadId: undefined,
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
        threadId: undefined,
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
  ])("$name", (testCase) => {
    const { globalAlert, jobAlert, expected } = testCase;
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
        channel: "deliveryChannel" in testCase ? testCase.deliveryChannel : "telegram",
        to: "deliveryTo" in testCase ? testCase.deliveryTo : "telegram:19098680",
        accountId: "telegram-bot",
        threadId: 42,
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
    const deferredNotifications: DeferredCronNotifications = [];

    applyJobResult(
      state,
      job,
      {
        status: "error",
        error: "provider unavailable",
        startedAt: runAtMs,
        endedAt,
      },
      { deferredNotifications },
    );

    expect(job.state.lastFailureAlertAtMs).toBe(endedAt);
    expect(sendCronFailureAlert).not.toHaveBeenCalled();
    deferredNotifications[0]?.();
    expect(sendCronFailureAlert).toHaveBeenCalledWith(expect.objectContaining({ runAtMs }));
  });

  it.each([
    { name: "inherited", failureAlert: undefined },
    { name: "explicitly repeated", failureAlert: { to: "telegram:19098680" } },
    { name: "provider-aliased", failureAlert: { to: "tg:19098680" } },
    {
      name: "mixed selected-channel aliases",
      deliveryChannel: "gchat",
      deliveryTo: "gchat:RoomA",
      failureAlert: { channel: "googlechat", to: "googlechat:RoomA" },
      expectedChannel: "googlechat",
    },
  ])("keeps the primary account and topic on $name failure alerts", (testCase) => {
    const { failureAlert } = testCase;
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createCronServiceState({
      storePath: "/tmp/openclaw-cron-failure-alert-thread-routing.json",
      cronEnabled: true,
      cronConfig: { failureAlert: { enabled: true, after: 1 } },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      sendCronFailureAlert,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job: CronJob = {
      id: "topic-routed-job",
      name: "Topic-routed job",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "report" },
      delivery: {
        mode: "announce",
        channel: "deliveryChannel" in testCase ? testCase.deliveryChannel : "telegram",
        to: "deliveryTo" in testCase ? testCase.deliveryTo : "telegram:19098680",
        accountId: "telegram-bot",
        threadId: 42,
      },
      ...(failureAlert ? { failureAlert } : {}),
      state: {},
    };
    const deferredNotifications: DeferredCronNotifications = [];

    applyJobResult(
      state,
      job,
      {
        status: "error",
        error: "provider unavailable",
        startedAt: 1,
        endedAt: 2,
      },
      { deferredNotifications },
    );

    expect(sendCronFailureAlert).not.toHaveBeenCalled();
    deferredNotifications[0]?.();
    expect(sendCronFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "expectedChannel" in testCase ? testCase.expectedChannel : "telegram",
        to: failureAlert?.to ?? "telegram:19098680",
        accountId: "telegram-bot",
        threadId: 42,
      }),
    );
  });
});
