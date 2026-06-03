import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronDelivery, CronJob } from "../../cron/types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

const getRuntimeConfig = vi.hoisted(() =>
  vi.fn<() => OpenClawConfig>(() => ({}) as OpenClawConfig),
);

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig,
  };
});

import { cronHandlers } from "./cron.js";

function createPrefixOnlyChannelPlugin(
  id: string,
  targetPrefixes: readonly string[],
  aliases?: readonly string[],
): ChannelPlugin {
  const base = createChannelTestPluginBase({ id });
  return {
    ...base,
    meta: {
      ...base.meta,
      ...(aliases ? { aliases } : {}),
    },
    messaging: { targetPrefixes },
  };
}

function setCronValidationTestRegistry(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        plugin: createPrefixOnlyChannelPlugin("telegram", ["telegram", "tg"]),
        source: "test:telegram",
      },
      {
        pluginId: "slack",
        plugin: createPrefixOnlyChannelPlugin("slack", ["slack"]),
        source: "test:slack",
      },
      {
        pluginId: "msteams",
        plugin: createPrefixOnlyChannelPlugin("msteams", ["msteams", "teams"], ["teams"]),
        source: "test:msteams",
      },
      {
        pluginId: "synology-chat",
        plugin: createPrefixOnlyChannelPlugin("synology-chat", [
          "synology-chat",
          "synology_chat",
          "synology",
        ]),
        source: "test:synology-chat",
      },
    ]),
  );
}

function createCronContext(currentJob?: CronJob) {
  return {
    cron: {
      add: vi.fn(async () => ({ id: "cron-1" })),
      update: vi.fn(async () => ({ id: "cron-1" })),
      remove: vi.fn(async () => ({ ok: true, removed: true })),
      enqueueRun: vi.fn(async () => ({ ok: true, enqueued: true, runId: "run-1" })),
      getDefaultAgentId: vi.fn(() => "main"),
      getJob: vi.fn(() => currentJob),
      wake: vi.fn(() => ({ ok: true }) as const),
      readJob: vi.fn(async (id: string) => (id === currentJob?.id ? currentJob : undefined)),
    },
    logGateway: {
      info: vi.fn(),
    },
    getRuntimeConfig: () => getRuntimeConfig(),
  };
}

type CronMethod = keyof typeof cronHandlers;

async function invokeCron(
  method: CronMethod,
  params: Record<string, unknown>,
  options: { currentJob?: CronJob; context?: ReturnType<typeof createCronContext> } = {},
) {
  const context = options.context ?? createCronContext(options.currentJob);
  const respond = vi.fn();
  await cronHandlers[method]({
    req: {} as never,
    params: params as never,
    respond: respond as never,
    context: context as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return { context, respond };
}

async function invokeCronAdd(params: Record<string, unknown>) {
  return await invokeCron("cron.add", params);
}

async function invokeCronGet(params: Record<string, unknown>, currentJob?: CronJob) {
  return await invokeCron("cron.get", params, { currentJob });
}

async function invokeCronUpdate(params: Record<string, unknown>, currentJob?: CronJob) {
  return await invokeCron("cron.update", params, { currentJob });
}

async function invokeCronUpdateDelivery(
  delivery: Record<string, unknown>,
  currentJob = createCronJob(),
) {
  return await invokeCronUpdate(
    {
      id: "cron-1",
      patch: { delivery },
    },
    currentJob,
  );
}

async function invokeCronRemove(
  params: Record<string, unknown>,
  options?: { removeResult?: { ok: boolean; removed: boolean } },
) {
  const context = createCronContext();
  if (options?.removeResult) {
    context.cron.remove.mockResolvedValueOnce(options.removeResult);
  }
  return await invokeCron("cron.remove", params, { context });
}

async function invokeWake(params: Record<string, unknown>) {
  return await invokeCron("wake", params);
}

function createCronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "cron-1",
    name: "cron job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    delivery: { mode: "none" },
    state: {},
    ...overrides,
  };
}

function telegramDeliveryWithSlackFailure(overrides: Partial<CronDelivery> = {}): CronDelivery {
  return {
    mode: "announce",
    channel: "telegram",
    to: "telegram:123",
    failureDestination: {
      mode: "announce",
      channel: "slack",
      to: "C123",
      accountId: "bot-b",
    },
    ...overrides,
  };
}

function setRuntimeConfig(config: OpenClawConfig): void {
  getRuntimeConfig.mockReturnValue(config);
}

function pluginEntries(...ids: string[]): OpenClawConfig["plugins"] {
  return {
    entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])),
  };
}

function telegramConfig(): OpenClawConfig {
  return {
    channels: {
      telegram: {
        botToken: "telegram-token",
      },
    },
    plugins: pluginEntries("telegram"),
  } as OpenClawConfig;
}

function telegramSlackConfig(params: { includeMainSession?: boolean } = {}): OpenClawConfig {
  return {
    ...(params.includeMainSession ? { session: { mainKey: "main" } } : {}),
    channels: {
      telegram: {
        botToken: "telegram-token",
      },
      slack: {
        botToken: "xoxb-slack-token",
        appToken: "xapp-slack-token",
      },
    },
    plugins: pluginEntries("telegram", "slack"),
  } as OpenClawConfig;
}

function msteamsConfig(): OpenClawConfig {
  return {
    channels: {
      msteams: {
        botToken: "teams-token",
      },
    },
    plugins: pluginEntries("msteams"),
  } as OpenClawConfig;
}

function slackSynologyConfig(): OpenClawConfig {
  return {
    channels: {
      slack: {
        botToken: "xoxb-slack-token",
        appToken: "xapp-slack-token",
      },
      "synology-chat": {
        token: "synology-token",
      },
    },
    plugins: pluginEntries("slack", "synology-chat"),
  } as OpenClawConfig;
}

function slackConfig(params: { includeMainSession?: boolean } = {}): OpenClawConfig {
  return {
    ...(params.includeMainSession ? { session: { mainKey: "main" } } : {}),
    channels: {
      slack: {
        botToken: "xoxb-slack-token",
        appToken: "xapp-slack-token",
      },
    },
    plugins: pluginEntries("slack"),
  } as OpenClawConfig;
}

function agentTurnCronParams(overrides: Record<string, unknown> = {}) {
  return {
    name: "cron job",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    ...overrides,
  };
}

function expectCronSuccess(respond: ReturnType<typeof vi.fn>): void {
  expect(respond).toHaveBeenCalledWith(true, { id: "cron-1" }, undefined);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function requireCronAddPayload(
  context: ReturnType<typeof createCronContext>,
): Record<string, unknown> {
  const calls = context.cron.add.mock.calls as unknown as [unknown][];
  return requireRecord(calls[0]?.[0], "cron.add payload");
}

function requireCronUpdatePatch(
  context: ReturnType<typeof createCronContext>,
): Record<string, unknown> {
  const calls = context.cron.update.mock.calls as unknown as [unknown, unknown][];
  return requireRecord(calls[0]?.[1], "cron.update patch");
}

function requireCronUpdateId(context: ReturnType<typeof createCronContext>): unknown {
  const calls = context.cron.update.mock.calls as unknown as [unknown, unknown][];
  return calls[0]?.[0];
}

function expectDeliveryFields(payload: Record<string, unknown>, expected: Record<string, unknown>) {
  const delivery = requireRecord(payload.delivery, "delivery");
  for (const [key, value] of Object.entries(expected)) {
    expect(delivery[key]).toBe(value);
  }
}

function expectCronUpdateDeliveryPatch(
  context: ReturnType<typeof createCronContext>,
  expected: unknown,
) {
  expect(context.cron.update).toHaveBeenCalled();
  expect(requireCronUpdatePatch(context).delivery).toEqual(expected);
}

function expectResponseError(
  respond: ReturnType<typeof vi.fn>,
  expected: { code?: string; messageIncludes?: string },
) {
  const call = respond.mock.calls.at(0);
  if (!call) {
    throw new Error("expected response call");
  }
  expect(call[0]).toBe(false);
  expect(call[1]).toBeUndefined();
  const error = requireRecord(call[2], "response error");
  if (expected.code) {
    expect(error.code).toBe(expected.code);
  }
  if (expected.messageIncludes) {
    expect(String(error.message)).toContain(expected.messageIncludes);
  }
}

function expectInvalidCronPatternError(respond: ReturnType<typeof vi.fn>): void {
  expectResponseError(respond, { code: "INVALID_REQUEST", messageIncludes: "CronPattern" });
}

describe("cron method validation", () => {
  beforeEach(() => {
    getRuntimeConfig.mockReset().mockReturnValue({} as OpenClawConfig);
    setCronValidationTestRegistry();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("accepts threadId on announce delivery add params", async () => {
    setRuntimeConfig(telegramConfig());

    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({
        name: "topic announce add",
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "-1001234567890",
          threadId: 123,
        },
      }),
    );

    expectDeliveryFields(requireCronAddPayload(context), {
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890",
      threadId: 123,
    });
    expectCronSuccess(respond);
  });

  it("returns invalid-request error when cron.remove target id is missing", async () => {
    const { respond } = await invokeCronRemove(
      { id: "missing-id" },
      { removeResult: { ok: true, removed: false } },
    );
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "invalid cron.remove params: id not found",
    });
  });

  it("returns a single cron job for cron.get", async () => {
    const job = createCronJob({ id: "cron-42", name: "single job" });

    const { context, respond } = await invokeCronGet({ id: "cron-42" }, job);

    expect(context.cron.readJob).toHaveBeenCalledWith("cron-42");
    expect(respond).toHaveBeenCalledWith(true, job, undefined);
  });

  it("returns INVALID_REQUEST when cron.get cannot find the job", async () => {
    const { respond } = await invokeCronGet({ jobId: "missing" });

    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "cron job not found: missing",
    });
  });

  it("accepts threadId on announce delivery update params", async () => {
    setRuntimeConfig(telegramConfig());

    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: {
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "-1001234567890",
            threadId: "456",
          },
        },
      },
      createCronJob({
        delivery: { mode: "announce", channel: "telegram", to: "-1001234567890" },
      }),
    );

    expect(requireCronUpdateId(context)).toBe("cron-1");
    expectDeliveryFields(requireCronUpdatePatch(context), {
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890",
      threadId: "456",
    });
    expectCronSuccess(respond);
  });

  it("rejects execution-derived diagnostics in cron.update state patches", async () => {
    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: {
          state: {
            lastDiagnostics: {
              summary: "forged",
              entries: [
                {
                  ts: 1,
                  source: "agent-run",
                  severity: "error",
                  message: "forged",
                },
              ],
            },
          },
        },
      },
      createCronJob(),
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, { code: "INVALID_REQUEST" });
  });

  it("rejects whitespace-only cron payloads before calling add", async () => {
    const agentTurn = await invokeCronAdd(
      agentTurnCronParams({
        name: "blank agent turn",
        payload: { kind: "agentTurn", message: "   " },
      }),
    );
    expect(agentTurn.context.cron.add).not.toHaveBeenCalled();
    expectResponseError(agentTurn.respond, { code: "INVALID_REQUEST", messageIncludes: "message" });

    const systemEvent = await invokeCronAdd({
      name: "blank system event",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "   " },
    });
    expect(systemEvent.context.cron.add).not.toHaveBeenCalled();
    expectResponseError(systemEvent.respond, { code: "INVALID_REQUEST", messageIncludes: "text" });
  });

  it("rejects ambiguous announce delivery on add when multiple channels are configured", async () => {
    setRuntimeConfig(telegramSlackConfig({ includeMainSession: true }));

    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({
        name: "ambiguous announce add",
        delivery: { mode: "announce" },
      }),
    );

    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, { messageIncludes: "delivery.channel is required" });
  });

  it("accepts provider-prefixed announce target without delivery.channel when multiple channels are configured", async () => {
    setRuntimeConfig(telegramSlackConfig({ includeMainSession: true }));

    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({
        name: "prefixed announce add",
        delivery: { mode: "announce", to: "telegram:123" },
      }),
    );

    expect(context.cron.add).toHaveBeenCalled();
    expectCronSuccess(respond);
  });

  it("rejects blank announce delivery fields before normalization", async () => {
    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({
        name: "blank delivery target",
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "   ",
        },
      }),
    );

    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "delivery.to must be a non-empty string",
    });
  });

  it("rejects blank failure destination fields before normalization", async () => {
    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({
        name: "blank failure target",
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "telegram:123",
          failureDestination: {
            mode: "announce",
            channel: "   ",
          },
        },
      }),
    );

    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "delivery.failureDestination.channel must be a non-empty string",
    });
  });

  it("rejects announce targets prefixed for a different explicit delivery channel", async () => {
    setRuntimeConfig(telegramSlackConfig());

    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({
        name: "mismatched announce add",
        delivery: { mode: "announce", channel: "slack", to: "telegram:123" },
      }),
    );

    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, { messageIncludes: "belongs to telegram, not slack" });
  });

  it("accepts provider-prefixed announce targets when delivery.channel uses a channel alias", async () => {
    setRuntimeConfig(msteamsConfig());

    for (const to of ["teams:19:meeting_abc@thread.tacv2", "msteams:19:meeting_abc@thread.tacv2"]) {
      const { context, respond } = await invokeCronAdd(
        agentTurnCronParams({
          name: `aliased announce add ${to}`,
          delivery: {
            mode: "announce",
            channel: "teams",
            to,
          },
        }),
      );

      expect(context.cron.add).toHaveBeenCalled();
      expectCronSuccess(respond);
    }
  });

  it("validates announce delivery patches that omit mode", async () => {
    setRuntimeConfig(telegramSlackConfig());

    const { context, respond } = await invokeCronUpdateDelivery(
      { channel: "slack", to: "telegram:123" },
      createCronJob({
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      }),
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, { messageIncludes: "belongs to telegram, not slack" });
  });

  it("accepts completion webhook delivery patches and nullable clears", async () => {
    const currentJob = createCronJob({
      delivery: { mode: "announce" },
    });

    const addResult = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: {
          delivery: {
            mode: "announce",
            completionDestination: {
              mode: "webhook",
              to: "https://example.invalid/cron-finished",
            },
          },
        },
      },
      currentJob,
    );

    expect(addResult.context.cron.update).toHaveBeenCalled();
    const addPatch = requireCronUpdatePatch(addResult.context);
    const addDelivery = requireRecord(addPatch.delivery, "delivery");
    expect(addDelivery.completionDestination).toEqual({
      mode: "webhook",
      to: "https://example.invalid/cron-finished",
    });

    const clearResult = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: {
          delivery: {
            completionDestination: null,
          },
        },
      },
      currentJob,
    );

    expect(clearResult.context.cron.update).toHaveBeenCalled();
    const clearPatch = requireCronUpdatePatch(clearResult.context);
    const clearDelivery = requireRecord(clearPatch.delivery, "delivery");
    expect(clearDelivery.completionDestination).toBeNull();
  });

  it("rejects blank delivery target patches before normalization", async () => {
    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: {
          delivery: {
            to: "\t",
          },
        },
      },
      createCronJob({
        delivery: { mode: "announce", channel: "telegram", to: "telegram:123" },
      }),
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "delivery.to must be a non-empty string",
    });
  });

  it("rejects blank completion destination patches before normalization", async () => {
    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: {
          delivery: {
            completionDestination: {
              mode: "webhook",
              to: " ",
            },
          },
        },
      },
      createCronJob({
        delivery: { mode: "announce" },
      }),
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "delivery.completionDestination.to must be a non-empty string",
    });
  });

  it("accepts nullable delivery target clears on update", async () => {
    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: {
          delivery: {
            channel: null,
            to: null,
            threadId: null,
            accountId: null,
            failureDestination: null,
          },
        },
      },
      createCronJob({
        delivery: telegramDeliveryWithSlackFailure({
          threadId: "99",
          accountId: "bot-a",
        }),
      }),
    );

    expectCronUpdateDeliveryPatch(context, {
      channel: null,
      to: null,
      threadId: null,
      accountId: null,
      failureDestination: null,
    });
    expectCronSuccess(respond);
  });

  it("accepts nullable failure destination field clears on update", async () => {
    setRuntimeConfig(telegramSlackConfig());

    const { context, respond } = await invokeCronUpdateDelivery(
      {
        failureDestination: {
          channel: null,
          to: null,
          accountId: null,
          mode: null,
        },
      },
      createCronJob({
        delivery: telegramDeliveryWithSlackFailure(),
      }),
    );

    expectCronUpdateDeliveryPatch(context, {
      failureDestination: {
        channel: null,
        to: null,
        accountId: null,
        mode: null,
      },
    });
    expectCronSuccess(respond);
  });

  it("rejects underscored provider prefixes for a different explicit delivery channel", async () => {
    setRuntimeConfig(slackSynologyConfig());

    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({
        name: "underscored mismatch add",
        delivery: { mode: "announce", channel: "slack", to: "synology_chat:123" },
      }),
    );

    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, { messageIncludes: "belongs to synology-chat, not slack" });
  });

  it("rejects ambiguous announce delivery on update when multiple channels are configured", async () => {
    setRuntimeConfig(telegramSlackConfig({ includeMainSession: true }));

    const { context, respond } = await invokeCronUpdateDelivery({ mode: "announce" });

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, { messageIncludes: "delivery.channel is required" });
  });

  it("loads the cron job before validating update delivery patches", async () => {
    getRuntimeConfig.mockReturnValue({
      session: {
        mainKey: "main",
      },
      channels: {
        telegram: {
          botToken: "telegram-token",
        },
        slack: {
          botToken: "xoxb-slack-token",
          appToken: "xapp-slack-token",
        },
      },
      plugins: {
        entries: {
          telegram: { enabled: true },
          slack: { enabled: true },
        },
      },
    } as OpenClawConfig);

    const context = createCronContext(createCronJob());
    context.cron.getJob.mockReturnValue(undefined);
    const respond = vi.fn();
    await cronHandlers["cron.update"]({
      req: {} as never,
      params: {
        id: "cron-1",
        patch: {
          delivery: { mode: "announce" },
        },
      } as never,
      respond: respond as never,
      context: context as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(context.cron.readJob).toHaveBeenCalledWith("cron-1");
    expect(context.cron.getJob).not.toHaveBeenCalled();
    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, { messageIncludes: "delivery.channel is required" });
  });

  it("does not revalidate stale delivery config for unrelated updates", async () => {
    setRuntimeConfig(slackConfig({ includeMainSession: true }));

    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: {
          enabled: false,
        },
      },
      createCronJob({
        delivery: { mode: "announce", channel: "telegram", to: "telegram:123" },
      }),
    );

    expect(context.cron.update).toHaveBeenCalledWith("cron-1", { enabled: false });
    expect(respond).toHaveBeenCalledWith(true, { id: "cron-1" }, undefined);
  });

  it("rejects target ids mistakenly supplied as delivery.channel providers", async () => {
    setRuntimeConfig(slackConfig({ includeMainSession: true }));

    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({
        name: "invalid delivery provider",
        delivery: {
          mode: "announce",
          channel: "C0AT2Q238MQ",
          to: "C0AT2Q238MQ",
        },
      }),
    );

    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, { messageIncludes: "delivery.channel must be one of: slack" });
  });

  it("returns INVALID_REQUEST when cron.add throws a croner parse error (#74066)", async () => {
    const context = createCronContext();
    context.cron.add.mockRejectedValueOnce(new TypeError("CronPattern: Expected 5 or 6 fields"));
    const { respond } = await invokeCron(
      "cron.add",
      {
        name: "bad-cron",
        enabled: true,
        schedule: { kind: "cron", expr: "not-a-cron-expr" },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "ping" },
      },
      { context },
    );

    expectInvalidCronPatternError(respond);
  });

  it("returns INVALID_REQUEST when cron.add rejects an incompatible main agent", async () => {
    const context = createCronContext();
    context.cron.add.mockRejectedValueOnce(
      new Error(
        'cron: sessionTarget "main" is only valid for the default agent. Use sessionTarget "isolated" with payload.kind "agentTurn" for non-default agents (agentId: worker)',
      ),
    );
    const { respond } = await invokeCron(
      "cron.add",
      {
        name: "bad-main-agent",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "ping" },
        agentId: "worker",
      },
      { context },
    );

    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: 'sessionTarget "main" is only valid',
    });
  });

  it("returns INVALID_REQUEST when cron.update throws a croner parse error (#74066)", async () => {
    const existingJob = createCronJob();
    const context = createCronContext(existingJob);
    context.cron.update.mockRejectedValueOnce(
      new RangeError("CronPattern: Value out of range (99)"),
    );
    const { respond } = await invokeCron(
      "cron.update",
      {
        id: existingJob.id,
        patch: {
          schedule: { kind: "cron", expr: "99 * * * *" },
        },
      },
      { context },
    );

    expectInvalidCronPatternError(respond);
  });

  it("returns INVALID_REQUEST when cron.update cannot find the job", async () => {
    const { context, respond } = await invokeCronUpdate({
      id: "missing",
      patch: { enabled: false },
    });

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "invalid cron.update params: id not found",
    });
  });

  it("rejects cron.update payload/session mismatches before calling the service update", async () => {
    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: {
          payload: { kind: "systemEvent", text: "wake main" },
        },
      },
      createCronJob({
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "hello" },
      }),
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: 'isolated/current/session cron jobs require payload.kind="agentTurn"',
    });
  });

  it("returns INVALID_REQUEST when cron.run cannot find the job", async () => {
    const context = createCronContext();
    context.cron.enqueueRun.mockRejectedValueOnce(new Error("unknown cron job id: missing"));
    const { respond } = await invokeCron("cron.run", { id: "missing" }, { context });

    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "unknown cron job id: missing",
    });
  });

  it("re-throws non-parse errors from cron.add instead of masking as INVALID_REQUEST", async () => {
    const context = createCronContext();
    context.cron.add.mockRejectedValueOnce(new Error("DB write failed"));
    const respond = vi.fn();
    await expect(
      cronHandlers["cron.add"]({
        req: {} as never,
        params: agentTurnCronParams({
          name: "db-fail",
          payload: { kind: "agentTurn", message: "ping" },
        }) as never,
        respond: respond as never,
        context: context as never,
        client: null,
        isWebchatConnect: () => false,
      }),
    ).rejects.toThrow("DB write failed");
    expect(respond).not.toHaveBeenCalled();
  });

  describe("wake", () => {
    it("forwards sessionKey to context.cron.wake when provided", async () => {
      const { context, respond } = await invokeWake({
        mode: "now",
        text: "ping",
        sessionKey: "agent:main:telegram:dm:42",
      });
      expect(context.cron.wake).toHaveBeenCalledWith({
        mode: "now",
        text: "ping",
        sessionKey: "agent:main:telegram:dm:42",
      });
      expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    });

    it("omits sessionKey when not provided", async () => {
      const { context, respond } = await invokeWake({
        mode: "next-heartbeat",
        text: "ping",
      });
      expect(context.cron.wake).toHaveBeenCalledWith({
        mode: "next-heartbeat",
        text: "ping",
      });
      expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    });

    it.each([
      { name: "empty-string sessionKey at schema", sessionKey: "" },
      { name: "non-string sessionKey at schema", sessionKey: 42 },
      {
        name: "subagent sessionKey targets before enqueueing",
        sessionKey: "agent:main:subagent:worker",
      },
    ])("rejects $name", async ({ sessionKey }) => {
      const { context, respond } = await invokeWake({
        mode: "now",
        text: "ping",
        sessionKey,
      });
      expect(context.cron.wake).not.toHaveBeenCalled();
      expectResponseError(respond, { code: "INVALID_REQUEST", messageIncludes: "sessionKey" });
    });

    it("treats whitespace-only sessionKey as omitted at the handler boundary", async () => {
      const { context, respond } = await invokeWake({
        mode: "now",
        text: "ping",
        sessionKey: "   ",
      });
      expect(context.cron.wake).toHaveBeenCalledWith({
        mode: "now",
        text: "ping",
      });
      expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    });
  });
});
