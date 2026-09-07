import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { CronJob } from "../types.js";
import { resolveFailureAlert } from "./failure-alerts.js";
import { createCronServiceState, type DeferredCronNotifications } from "./state.js";
import { applyJobResult, authorCronRunCompletion } from "./timer.js";

function stripTestTargetPrefix(raw: string, prefixes: readonly string[]): string | undefined {
  const target = raw
    .trim()
    .replace(new RegExp(`^(?:${prefixes.join("|")}):`, "i"), "")
    .trim();
  return target || undefined;
}

function normalizeDiscordTestTarget(raw: string): string | undefined {
  const target = raw.trim().toLowerCase();
  if (!target) {
    return undefined;
  }
  if (target.startsWith("discord:channel:")) {
    return target.slice("discord:".length);
  }
  if (target.startsWith("discord:")) {
    return `user:${target.slice("discord:".length)}`;
  }
  return /^(channel|user):/.test(target) ? target : `channel:${target}`;
}

describe("cron failure alert account routing", () => {
  beforeEach(() => {
    const pluginSpecs = [
      {
        id: "telegram",
        aliases: [],
        targetPrefixes: ["telegram", "tg"],
        normalizeTarget: (raw: string) => {
          const target = stripTestTargetPrefix(raw, ["telegram", "tg"]);
          return target ? `telegram:${target}` : undefined;
        },
      },
      {
        id: "googlechat",
        aliases: ["gchat", "google-chat"],
        targetPrefixes: ["googlechat", "google-chat", "gchat"],
        normalizeTarget: (raw: string) =>
          stripTestTargetPrefix(raw, ["googlechat", "google-chat", "gchat"]),
      },
      {
        id: "msteams",
        aliases: ["teams"],
        targetPrefixes: ["msteams", "teams"],
        normalizeTarget: (raw: string) => stripTestTargetPrefix(raw, ["msteams", "teams"]),
      },
      {
        id: "discord",
        aliases: [],
        targetPrefixes: ["discord"],
        normalizeTarget: normalizeDiscordTestTarget,
      },
    ];
    setActivePluginRegistry(
      createTestRegistry(
        pluginSpecs.map(({ id, aliases, targetPrefixes, normalizeTarget }) => {
          const plugin = createChannelTestPluginBase({ id });
          return {
            pluginId: id,
            plugin: {
              ...plugin,
              meta: { ...plugin.meta, aliases },
              messaging: { targetPrefixes, normalizeTarget },
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
      name: "keeps an explicitly unthreaded same-chat failure destination separate",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: undefined,
      failureDestination: {
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
      },
      expected: {
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
        threadId: undefined,
        alternateRoute: true,
      },
    },
    {
      name: "keeps an aliased unthreaded same-chat failure destination separate",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: undefined,
      failureDestination: {
        channel: "telegram",
        to: "tg:19098680",
        accountId: "telegram-bot",
      },
      expected: {
        channel: "telegram",
        to: "tg:19098680",
        accountId: "telegram-bot",
        threadId: undefined,
        alternateRoute: true,
      },
    },
    {
      name: "keeps numeric zero as a distinct primary thread",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: undefined,
      deliveryThreadId: 0,
      failureDestination: {
        channel: "telegram",
        to: "tg:19098680",
        accountId: "telegram-bot",
      },
      expected: {
        channel: "telegram",
        to: "tg:19098680",
        accountId: "telegram-bot",
        threadId: undefined,
        alternateRoute: true,
      },
    },
    {
      name: "does not classify an unthreaded provider alias as an alternate route",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: undefined,
      deliveryThreadId: undefined,
      failureDestination: {
        channel: "telegram",
        to: "tg:19098680",
        accountId: "telegram-bot",
      },
      expected: {
        channel: "telegram",
        to: "tg:19098680",
        accountId: "telegram-bot",
        threadId: undefined,
        alternateRoute: false,
      },
    },
    {
      name: "lets an explicit alert route override an unthreaded failure destination",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: { to: "tg:19098680" },
      failureDestination: {
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
      },
      expected: {
        channel: "telegram",
        to: "tg:19098680",
        accountId: "telegram-bot",
        threadId: 42,
        alternateRoute: false,
      },
    },
    {
      name: "preserves an unthreaded failure destination when the alert only selects its account",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: { accountId: "telegram-bot" },
      failureDestination: {
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
      },
      expected: {
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
        threadId: undefined,
        alternateRoute: true,
      },
    },
    {
      name: "preserves an unthreaded failure destination when the alert only selects its mode",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: { mode: "announce" as const },
      failureDestination: {
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
      },
      expected: {
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
        threadId: undefined,
        alternateRoute: true,
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
      name: "does not equate Discord user and channel targets with the same id",
      globalAlert: { enabled: true, after: 1 },
      deliveryChannel: "discord",
      deliveryTo: "1234567890",
      jobAlert: { channel: "discord", to: "discord:1234567890" },
      expected: {
        channel: "discord",
        to: "discord:1234567890",
        accountId: undefined,
        threadId: undefined,
      },
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
        threadId: "deliveryThreadId" in testCase ? testCase.deliveryThreadId : 42,
        ...("failureDestination" in testCase
          ? { failureDestination: testCase.failureDestination }
          : {}),
      },
      ...(jobAlert ? { failureAlert: jobAlert } : {}),
      state: {},
    };

    expect(resolveFailureAlert(state, job)).toMatchObject(expected);
  });

  it.each([
    {
      name: "required primary delivery failure",
      result: {
        status: "ok" as const,
        deliveryAttempted: true,
        delivered: false,
        deliveryError: "topic closed",
        startedAt: 1_000,
        endedAt: 2_000,
      },
      expectedText: 'Automation "Topic-routed job" delivery failed',
      expectAlert: true,
    },
    {
      name: "execution failure",
      result: {
        status: "error" as const,
        error: "provider unavailable",
        startedAt: 1_000,
        endedAt: 2_000,
      },
      expectedText: 'Automation "Topic-routed job" failed 1 times',
      expectAlert: true,
    },
    {
      name: "unthreaded primary delivery failure with an equivalent provider alias",
      result: {
        status: "ok" as const,
        deliveryAttempted: true,
        delivered: false,
        deliveryError: "recipient unavailable",
        startedAt: 1_000,
        endedAt: 2_000,
      },
      deliveryThreadId: undefined,
      failureTo: "tg:19098680",
      expectedText: "",
      expectAlert: false,
    },
  ])("handles failure alert routing after $name", (testCase) => {
    const { result, expectedText, expectAlert } = testCase;
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createCronServiceState({
      storePath: "/tmp/openclaw-cron-unthreaded-failure-destination.json",
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
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
        threadId: "deliveryThreadId" in testCase ? testCase.deliveryThreadId : 42,
        bestEffort: false,
        failureDestination: {
          channel: "telegram",
          to: "failureTo" in testCase ? testCase.failureTo : "telegram:19098680",
          accountId: "telegram-bot",
        },
      },
      state: {},
    };
    const deferredNotifications: DeferredCronNotifications = [];

    applyJobResult(state, job, result, { deferredNotifications });

    expect(deferredNotifications).toHaveLength(expectAlert ? 1 : 0);
    expect(sendCronFailureAlert).not.toHaveBeenCalled();
    if (!expectAlert) {
      return;
    }
    deferredNotifications[0]?.();
    expect(sendCronFailureAlert).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
        threadId: undefined,
        inheritSessionThread: false,
        payload: expect.objectContaining({
          text: `${expectedText}\nCheck automation history for details.`,
        }),
      }),
    );
  });

  it.each(
    (["not-delivered", "unknown"] as const).flatMap((deliveryStatus) =>
      [false, true].map((implicit) => ({ deliveryStatus, implicit })),
    ),
  )(
    "records $deliveryStatus delivery and only alerts for a known failure (implicit=$implicit)",
    ({ deliveryStatus, implicit }) => {
      const sendCronFailureAlert = vi.fn(async () => undefined);
      const state = createCronServiceState({
        storePath: "/tmp/openclaw-cron-recorded-delivery-alert.json",
        cronEnabled: true,
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        sendCronFailureAlert,
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const job: CronJob = {
        id: "recorded-delivery",
        name: "Recorded delivery",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "report" },
        ...(implicit ? {} : { delivery: { mode: "announce" as const } }),
        failureAlert: { mode: "webhook", to: "https://alerts.example.test/cron" },
        state: {},
      };
      const deferredNotifications: DeferredCronNotifications = [];
      const outcome = authorCronRunCompletion(state, job, {
        status: "ok",
        deliveryState: {
          delivered: deliveryStatus === "not-delivered" ? false : undefined,
          status: deliveryStatus,
          error: "recorded transport failure",
          failureNotification: { status: "not-requested" },
        },
      });
      expect(outcome.completionStatus).toBe(
        deliveryStatus === "not-delivered" ? "failed" : "unknown",
      );
      applyJobResult(
        state,
        job,
        {
          ...outcome,
          startedAt: 1_000,
          endedAt: 2_000,
        },
        { deferredNotifications },
      );

      expect(job.state.lastDeliveryError).toBe("recorded transport failure");
      expect(deferredNotifications).toHaveLength(deliveryStatus === "not-delivered" ? 1 : 0);
      if (deliveryStatus === "unknown") {
        return;
      }
      deferredNotifications[0]?.();
      expect(sendCronFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: {
            text: 'Automation "Recorded delivery" delivery failed\nLast error: recorded transport failure',
          },
        }),
      );
    },
  );

  it.each([
    {
      name: "failure destination channel alias",
      channel: "googlechat",
      globalChannel: "googlechat",
      failureDestination: { channel: "gchat" },
      failureAlert: undefined,
    },
    {
      name: "job alert channel alias",
      channel: "googlechat",
      globalChannel: "googlechat",
      failureDestination: undefined,
      failureAlert: { channel: "google-chat" },
    },
    {
      name: "both independently aliased overrides",
      channel: "googlechat",
      globalChannel: "googlechat",
      failureDestination: { channel: "gchat" },
      failureAlert: { channel: "google-chat" },
    },
    {
      name: "prefixed target with an inherited last channel",
      channel: "googlechat",
      globalChannel: "last",
      targetPrefix: "gchat",
      failureDestination: { channel: "gchat" },
      failureAlert: undefined,
    },
    {
      name: "Teams channel alias",
      channel: "msteams",
      globalChannel: "msteams",
      failureDestination: undefined,
      failureAlert: { channel: "teams" },
    },
  ])("delivers the inherited failure route through $name", (testCase) => {
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const recipient = `${"targetPrefix" in testCase ? testCase.targetPrefix : testCase.channel}:alerts`;
    const state = createCronServiceState({
      storePath: "/tmp/openclaw-cron-failure-alert-aliased-routing.json",
      cronEnabled: true,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
          mode: "announce",
          channel: testCase.globalChannel,
          to: recipient,
          accountId: `${testCase.channel}-bot`,
        },
      },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowMs: () => 2_000,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      sendCronFailureAlert,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job: CronJob = {
      id: "aliased-failure-route",
      name: "Aliased failure route",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "report" },
      delivery: {
        mode: "none",
        ...(testCase.failureDestination ? { failureDestination: testCase.failureDestination } : {}),
      },
      ...(testCase.failureAlert ? { failureAlert: testCase.failureAlert } : {}),
      state: {},
    };
    const deferredNotifications: DeferredCronNotifications = [];

    applyJobResult(
      state,
      job,
      {
        status: "error",
        error: "provider unavailable",
        startedAt: 1_000,
        endedAt: 2_000,
      },
      { deferredNotifications },
    );
    deferredNotifications[0]?.();

    expect(sendCronFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: testCase.channel,
        to: recipient,
        accountId: `${testCase.channel}-bot`,
      }),
    );
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
    {
      name: "plugin-normalized equivalent",
      deliveryChannel: "discord",
      deliveryTo: "1234567890",
      failureAlert: { channel: "discord", to: "discord:channel:1234567890" },
      expectedChannel: "discord",
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
