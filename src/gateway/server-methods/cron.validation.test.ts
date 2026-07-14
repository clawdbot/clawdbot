// Cron validation tests cover channel target validation against plugin
// prefixes/aliases and runtime config for cron delivery destinations.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronDelivery, CronJob } from "../../cron/types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { GatewayClient } from "./types.js";

const getRuntimeConfig = vi.hoisted(() =>
  vi.fn<() => OpenClawConfig>(() => ({}) as OpenClawConfig),
);
const loadGatewaySessionEntry = vi.hoisted(() =>
  vi.fn(
    (
      sessionKey: string,
    ): {
      canonicalKey: string;
      entry?: {
        agentHarnessId?: unknown;
        modelSelectionLocked?: unknown;
        sessionId?: unknown;
      };
    } => ({ canonicalKey: sessionKey, entry: undefined }),
  ),
);

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig,
  };
});

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: loadGatewaySessionEntry,
}));

import { cronHandlers } from "./cron.js";

function createPrefixOnlyChannelPlugin(
  id: string,
  targetPrefixes: readonly string[],
  aliases?: readonly string[],
): ChannelPlugin {
  const base = createChannelTestPluginBase({
    id,
    config: {
      isConfigured: (_account, cfg) => {
        const channelConfig = cfg.channels?.[id];
        return Boolean(channelConfig && channelConfig.enabled !== false);
      },
    },
  });
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

function createCronContext(currentJobs?: CronJob | CronJob[]) {
  const jobs = currentJobs ? (Array.isArray(currentJobs) ? currentJobs : [currentJobs]) : [];
  const update = vi.fn(async (id: string, patch: Partial<CronJob>) =>
    createCronJob({
      ...jobs.find((job) => job.id === id),
      ...patch,
      id,
    }),
  );
  return {
    cron: {
      add: vi.fn(async (input: Partial<CronJob>, _opts?: unknown) =>
        createCronJob({ ...input, id: "cron-1" }),
      ),
      update,
      updateWithPrecondition: vi.fn(
        async (
          id: string,
          patch: Partial<CronJob>,
          precondition: (job: CronJob, nowMs: number) => void | Promise<void>,
        ) => {
          const job = jobs.find((candidate) => candidate.id === id);
          if (!job) {
            throw new Error(`unknown cron job id: ${id}`);
          }
          await precondition(job, Date.now());
          return await update(id, patch);
        },
      ),
      remove: vi.fn(async () => ({ ok: true, removed: true })),
      enqueueRun: vi.fn(async () => ({ ok: true, enqueued: true, runId: "run-1" })),
      getDefaultAgentId: vi.fn(() => "main"),
      getJob: vi.fn((id: string) => jobs.find((job) => job.id === id)),
      wake: vi.fn(() => ({ ok: true }) as const),
      readJob: vi.fn(async (id: string) => jobs.find((job) => job.id === id)),
      list: vi.fn(async () => jobs),
      listPage: vi.fn(async (opts?: { agentId?: string; limit?: number; offset?: number }) => {
        const requestedAgentId = opts?.agentId?.trim().toLowerCase();
        const filteredJobs = requestedAgentId
          ? jobs.filter((job) => (job.agentId ?? "main").trim().toLowerCase() === requestedAgentId)
          : jobs;
        const total = filteredJobs.length;
        const offset = Math.max(0, Math.min(total, Math.floor(opts?.offset ?? 0)));
        const defaultLimit = total === 0 ? 50 : total;
        const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? defaultLimit)));
        const pageJobs = filteredJobs.slice(offset, offset + limit);
        const nextOffset = offset + pageJobs.length;
        return {
          jobs: pageJobs,
          total,
          offset,
          limit,
          hasMore: nextOffset < total,
          nextOffset: nextOffset < total ? nextOffset : null,
        };
      }),
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
  options: {
    currentJob?: CronJob;
    context?: ReturnType<typeof createCronContext>;
    client?: GatewayClient;
  } = {},
) {
  const context = options.context ?? createCronContext(options.currentJob);
  const respond = vi.fn();
  await expectDefined(
    cronHandlers[method],
    "cronHandlers[method] test invariant",
  )({
    req: {} as never,
    params: params as never,
    respond: respond as never,
    context: context as never,
    client: options.client ?? null,
    isWebchatConnect: () => false,
  });
  return { context, respond };
}

async function invokeCronAdd(
  params: Record<string, unknown>,
  options?: { client?: GatewayClient },
) {
  return await invokeCron("cron.add", params, options);
}

async function invokeCronGet(
  params: Record<string, unknown>,
  currentJob?: CronJob,
  options?: { client?: GatewayClient },
) {
  return await invokeCron("cron.get", params, { currentJob, ...options });
}

async function invokeCronUpdate(
  params: Record<string, unknown>,
  currentJob?: CronJob,
  options?: { client?: GatewayClient },
) {
  return await invokeCron("cron.update", params, { currentJob, ...options });
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
  options?: { removeResult?: { ok: boolean; removed: boolean }; client?: GatewayClient },
) {
  const context = createCronContext();
  if (options?.removeResult) {
    context.cron.remove.mockResolvedValueOnce(options.removeResult);
  }
  return await invokeCron("cron.remove", params, { context, client: options?.client });
}

async function invokeWake(params: Record<string, unknown>, client?: GatewayClient) {
  return await invokeCron("wake", params, { client });
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

function callerClient(agentId: string): GatewayClient {
  return {
    connect: {} as GatewayClient["connect"],
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId,
        sessionKey: `agent:${agentId}:main`,
      },
    },
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
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ id: "cron-1" }), undefined);
}

function expectCronReadSuccess(respond: ReturnType<typeof vi.fn>, job: CronJob): void {
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ ...job, configRevision: expect.stringMatching(/^sha256:/) }),
    undefined,
  );
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
    loadGatewaySessionEntry
      .mockReset()
      .mockImplementation((sessionKey: string) => ({ canonicalKey: sessionKey, entry: undefined }));
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

  it("allows caller-scoped cron.remove for the same agent", async () => {
    const context = createCronContext(createCronJob({ id: "cron-1", agentId: "ops" }));

    const { respond } = await invokeCron(
      "cron.remove",
      { id: "cron-1" },
      { context, client: callerClient("ops") },
    );

    expect(context.cron.remove).toHaveBeenCalledWith("cron-1");
    expect(respond).toHaveBeenCalledWith(true, { ok: true, removed: true }, undefined);
  });

  it("hides caller-scoped cron.remove for a foreign agent", async () => {
    const context = createCronContext(createCronJob({ id: "cron-1", agentId: "worker" }));

    const { respond } = await invokeCron(
      "cron.remove",
      { jobId: "cron-1" },
      { context, client: callerClient("ops") },
    );

    expect(context.cron.remove).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "invalid cron.remove params: id not found",
    });
  });

  it("hides operator command cron jobs from caller-scoped cron.remove", async () => {
    const context = createCronContext(
      createCronJob({
        id: "cron-1",
        agentId: "ops",
        payload: {
          kind: "command",
          argv: ["deploy"],
          env: { MARKER_ENV: "fixture-marker" },
        },
      }),
    );

    const { respond } = await invokeCron(
      "cron.remove",
      { id: "cron-1" },
      { context, client: callerClient("ops") },
    );

    expect(context.cron.remove).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "invalid cron.remove params: id not found",
    });
  });

  it("returns a single cron job for cron.get", async () => {
    const job = createCronJob({ id: "cron-42", name: "single job" });

    const { context, respond } = await invokeCronGet({ id: "cron-42" }, job);

    expect(context.cron.readJob).toHaveBeenCalledWith("cron-42");
    expectCronReadSuccess(respond, job);
  });

  it("allows caller-scoped cron.get for the same agent", async () => {
    const job = createCronJob({ id: "cron-42", agentId: "ops" });

    const { respond } = await invokeCronGet({ id: "cron-42" }, job, {
      client: callerClient("ops"),
    });

    expectCronReadSuccess(respond, job);
  });

  it("hides caller-scoped cron.get for a foreign agent", async () => {
    const job = createCronJob({ id: "cron-42", agentId: "ops" });

    const { respond } = await invokeCronGet({ jobId: "cron-42" }, job, {
      client: callerClient("worker"),
    });

    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "cron job not found: cron-42",
    });
  });

  it("hides caller-scoped cron.get when stored sessionTarget points at a foreign agent", async () => {
    const job = createCronJob({
      id: "cron-42",
      agentId: "ops",
      sessionTarget: "session:agent:worker:telegram:direct:alice",
    });

    const { respond } = await invokeCronGet({ id: "cron-42" }, job, {
      client: callerClient("ops"),
    });

    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "cron job not found: cron-42",
    });
  });

  it("hides same-agent command cron payloads from caller-scoped cron.get", async () => {
    const job = createCronJob({
      id: "cron-42",
      agentId: "ops",
      payload: {
        kind: "command",
        argv: ["deploy"],
        env: { MARKER_ENV: "fixture-marker" },
      },
    });

    const { respond } = await invokeCronGet({ id: "cron-42" }, job, {
      client: callerClient("ops"),
    });

    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "cron job not found: cron-42",
    });
    expect(JSON.stringify(respond.mock.calls)).not.toContain("fixture-marker");
  });

  it("hides same-agent on-exit cron jobs from caller-scoped cron.get", async () => {
    const job = createCronJob({
      id: "cron-42",
      agentId: "ops",
      schedule: { kind: "on-exit", command: "deploy" },
    });

    const { respond } = await invokeCronGet({ id: "cron-42" }, job, {
      client: callerClient("ops"),
    });

    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "cron job not found: cron-42",
    });
    expect(JSON.stringify(respond.mock.calls)).not.toContain("deploy");
  });

  it("returns INVALID_REQUEST when cron.get cannot find the job", async () => {
    const { respond } = await invokeCronGet({ jobId: "missing" });

    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "cron job not found: missing",
    });
  });

  it("scopes cron.list to the caller agent", async () => {
    const context = createCronContext(createCronJob({ agentId: "ops" }));

    const { respond } = await invokeCron(
      "cron.list",
      { includeDisabled: true, compact: true },
      { context, client: callerClient("ops") },
    );

    expect(context.cron.listPage).toHaveBeenCalledWith(
      expect.objectContaining({ includeDisabled: true, agentId: undefined }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ total: 1, jobs: expect.any(Array) }),
      undefined,
    );
  });

  it("filters operator command cron jobs from caller-scoped cron.list", async () => {
    const context = createCronContext([
      createCronJob({
        id: "command-job",
        agentId: "ops",
        payload: {
          kind: "command",
          argv: ["deploy"],
          env: { MARKER_ENV: "fixture-marker" },
        },
      }),
      createCronJob({ id: "agent-job", agentId: "ops", name: "agent job" }),
    ]);

    const { respond } = await invokeCron(
      "cron.list",
      { includeDisabled: true, compact: true },
      { context, client: callerClient("ops") },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        total: 1,
        jobs: [expect.objectContaining({ id: "agent-job" })],
      }),
      undefined,
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain("fixture-marker");
  });

  it("rejects caller-scoped cron.list for a foreign explicit agentId", async () => {
    const context = createCronContext(createCronJob({ agentId: "ops" }));

    const { respond } = await invokeCron(
      "cron.list",
      { agentId: "worker" },
      { context, client: callerClient("ops") },
    );

    expect(context.cron.listPage).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "agentId outside caller scope",
    });
  });

  it("keeps unscoped cron.list agentId filtering global for operator callers", async () => {
    const context = createCronContext(createCronJob({ agentId: "worker" }));

    const { respond } = await invokeCron("cron.list", { agentId: "worker" }, { context });

    expect(context.cron.listPage).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "worker" }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ total: 1, jobs: expect.any(Array) }),
      undefined,
    );
  });

  it("filters caller-scoped cron.list jobs with foreign session targets before pagination", async () => {
    const foreignSessionJob = createCronJob({
      id: "cron-foreign",
      agentId: "ops",
      sessionTarget: "session:agent:worker:telegram:direct:alice",
    });
    const firstSafeJob = createCronJob({
      id: "cron-safe-1",
      agentId: "ops",
      sessionTarget: "session:agent:ops:telegram:direct:bob",
    });
    const secondSafeJob = createCronJob({
      id: "cron-safe-2",
      agentId: "ops",
    });
    const context = createCronContext([foreignSessionJob, firstSafeJob, secondSafeJob]);

    const { respond } = await invokeCron(
      "cron.list",
      { compact: true, limit: 1 },
      { context, client: callerClient("ops") },
    );

    expect(context.cron.listPage).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: undefined }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        total: 2,
        offset: 0,
        limit: 1,
        hasMore: true,
        nextOffset: 1,
        jobs: [expect.objectContaining({ id: "cron-safe-1" })],
      }),
      undefined,
    );
  });

  it("allows internally scoped cron.add for the same agent without persisting caller identity", async () => {
    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({
        agentId: "ops",
      }),
      { client: callerClient("ops") },
    );

    const payload = requireCronAddPayload(context);
    expect(payload.agentId).toBe("ops");
    expect(payload).not.toHaveProperty("callerScope");
    expectCronSuccess(respond);
  });

  it("defaults scoped cron.add ownership to the trusted caller when agentId is omitted", async () => {
    const { context, respond } = await invokeCronAdd(agentTurnCronParams(), {
      client: callerClient("ops"),
    });

    const payload = requireCronAddPayload(context);
    expect(payload.agentId).toBe("ops");
    expect(payload).not.toHaveProperty("callerScope");
    expectCronSuccess(respond);
  });

  it.each([
    {
      name: "explicit reserved target",
      params: { sessionTarget: "session:harness:codex:supervision:native-thread" },
    },
    {
      name: "current target resolved from a reserved caller session",
      params: {
        sessionTarget: "current",
        sessionKey: "agent:main:harness:codex:supervision:native-thread",
      },
    },
  ])("rejects cron.add for $name", async ({ params }) => {
    const { context, respond } = await invokeCronAdd(agentTurnCronParams(params));

    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "reserved for agent harness-owned sessions",
    });
  });

  it("rejects cron.update retargeting into a reserved harness session", async () => {
    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: { sessionTarget: "session:agent:main:harness:codex:supervision:native-thread" },
      },
      createCronJob(),
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "reserved for agent harness-owned sessions",
    });
  });

  it.each(["add", "update"] as const)(
    "allows cron.%s to target a pre-existing unlocked harness-prefixed session",
    async (method) => {
      const sessionKey = "agent:main:harness:legacy-notes";
      loadGatewaySessionEntry.mockReturnValue({
        canonicalKey: sessionKey,
        entry: { agentHarnessId: "codex", sessionId: "legacy-session" },
      });

      const result =
        method === "add"
          ? await invokeCronAdd(
              agentTurnCronParams({
                agentId: "main",
                sessionTarget: `session:${sessionKey}`,
              }),
            )
          : await invokeCronUpdate(
              { id: "cron-1", patch: { sessionTarget: `session:${sessionKey}` } },
              createCronJob({ agentId: "main" }),
            );

      if (method === "add") {
        expect(result.context.cron.add).toHaveBeenCalled();
      } else {
        expect(result.context.cron.update).toHaveBeenCalled();
      }
      expect(result.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ id: "cron-1" }),
        undefined,
      );
    },
  );

  it("rejects cron.add targeting an existing locked harness session", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    loadGatewaySessionEntry.mockReturnValue({
      canonicalKey: sessionKey,
      entry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        sessionId: "native-session",
      },
    });

    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({ sessionTarget: `session:${sessionKey}` }),
    );

    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "reserved for agent harness-owned sessions",
    });
  });

  it.each(["add", "update"] as const)(
    "rejects cron.%s targeting an existing locked ordinary session",
    async (method) => {
      const sessionKey = "agent:main:project-native-session";
      loadGatewaySessionEntry.mockReturnValue({
        canonicalKey: sessionKey,
        entry: {
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          sessionId: "native-session",
        },
      });

      const result =
        method === "add"
          ? await invokeCronAdd(
              agentTurnCronParams({
                agentId: "main",
                sessionTarget: `session:${sessionKey}`,
              }),
            )
          : await invokeCronUpdate(
              { id: "cron-1", patch: { sessionTarget: `session:${sessionKey}` } },
              createCronJob({ agentId: "main" }),
            );

      if (method === "add") {
        expect(result.context.cron.add).not.toHaveBeenCalled();
      } else {
        expect(result.context.cron.update).not.toHaveBeenCalled();
      }
      expectResponseError(result.respond, {
        code: "INVALID_REQUEST",
        messageIncludes: "identity is locked and cannot be replaced or shared",
      });
    },
  );

  it("revalidates an unchanged session target when cron.update changes its agent", async () => {
    const sessionKey = "project-native-session";
    loadGatewaySessionEntry.mockReturnValue({
      canonicalKey: `agent:worker:${sessionKey}`,
      entry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        sessionId: "native-session",
      },
    });

    const { context, respond } = await invokeCronUpdate(
      { id: "cron-1", patch: { agentId: "worker" } },
      createCronJob({ agentId: "main", sessionTarget: `session:${sessionKey}` }),
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "identity is locked and cannot be replaced or shared",
    });
  });

  it("keeps a harness-origin key as routing context for a main-session job", async () => {
    const { context, respond } = await invokeCronAdd({
      name: "main reminder",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      sessionKey: "agent:main:harness:codex:supervision:native-thread",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "remind me" },
    });

    expect(context.cron.add).toHaveBeenCalled();
    expectCronSuccess(respond);
  });

  it("rejects wake requests targeting reserved harness sessions", async () => {
    const { context, respond } = await invokeWake({
      mode: "now",
      text: "ping",
      sessionKey: "agent:main:harness:codex:supervision:native-thread",
    });

    expect(context.cron.wake).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "reserved for agent harness-owned sessions",
    });
  });

  it("allows wake requests for an existing locked harness-owned session", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    loadGatewaySessionEntry.mockReturnValueOnce({
      canonicalKey: sessionKey,
      entry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        sessionId: "native-session",
      },
    });

    const { context, respond } = await invokeWake({
      mode: "now",
      text: "ping",
      sessionKey,
    });

    expect(context.cron.wake).toHaveBeenCalledWith({
      mode: "now",
      text: "ping",
      sessionKey,
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("allows wake requests for a pre-existing unlocked harness-prefixed session", async () => {
    const sessionKey = "agent:main:harness:legacy-notes";
    loadGatewaySessionEntry.mockReturnValueOnce({
      canonicalKey: sessionKey,
      entry: { agentHarnessId: "codex", sessionId: "legacy-session" },
    });

    const { context, respond } = await invokeWake({
      mode: "now",
      text: "ping",
      sessionKey,
    });

    expect(context.cron.wake).toHaveBeenCalledWith({
      mode: "now",
      text: "ping",
      sessionKey,
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("stamps declaration ownership from the trusted caller and scopes key lookup", async () => {
    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({
        declarationKey: "daily-report",
        owner: { agentId: "spoofed", sessionKey: "agent:spoofed:main" },
      }),
      { client: callerClient("ops") },
    );

    const payload = requireCronAddPayload(context);
    expect(payload.owner).toEqual({ agentId: "ops", sessionKey: "agent:ops:main" });
    const options = requireRecord(context.cron.add.mock.calls[0]?.[1], "cron.add options");
    const matchesExisting = options.matchesExisting as ((job: CronJob) => boolean) | undefined;
    expect(matchesExisting?.(createCronJob({ agentId: "ops" }))).toBe(true);
    expect(matchesExisting?.(createCronJob({ agentId: "worker" }))).toBe(false);
    expect(matchesExisting?.(createCronJob({ agentId: "worker", owner: { agentId: "ops" } }))).toBe(
      true,
    );
    expect(matchesExisting?.(createCronJob({ agentId: "ops", owner: { agentId: "worker" } }))).toBe(
      false,
    );
    expectCronSuccess(respond);
  });

  it("keeps scoped read access with the stamped owner after operator retargeting", async () => {
    const job = createCronJob({
      agentId: "worker",
      owner: { agentId: "ops", sessionKey: "agent:ops:main" },
    });
    const context = createCronContext(job);

    const { respond } = await invokeCron(
      "cron.list",
      { compact: true },
      { context, client: callerClient("ops") },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ total: 1, jobs: [expect.objectContaining({ id: "cron-1" })] }),
      undefined,
    );
  });

  it("keeps explicit declaration ownership for operator callers", async () => {
    const owner = { agentId: "ops", sessionKey: "agent:ops:main" };
    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({ declarationKey: "daily-report", owner }),
    );

    expect(requireCronAddPayload(context).owner).toEqual(owner);
    const options = requireRecord(context.cron.add.mock.calls[0]?.[1], "cron.add options");
    const matchesExisting = options.matchesExisting as ((job: CronJob) => boolean) | undefined;
    expect(matchesExisting?.(createCronJob({ owner }))).toBe(true);
    expect(
      matchesExisting?.(
        createCronJob({ owner: { agentId: "ops", sessionKey: "agent:ops:other" } }),
      ),
    ).toBe(true);
    expect(matchesExisting?.(createCronJob({ owner: { agentId: "worker" } }))).toBe(false);
    expectCronSuccess(respond);
  });

  it("returns the published declarative cron.add result shape", async () => {
    const context = createCronContext();
    const job = createCronJob({ declarationKey: "daily-report" });
    context.cron.add.mockImplementationOnce(
      async () => ({ ...job, created: false, updated: false, job }) as never,
    );
    const { respond } = await invokeCron(
      "cron.add",
      agentTurnCronParams({ declarationKey: "daily-report" }),
      { context },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        created: false,
        updated: false,
        job: expect.objectContaining({ id: "cron-1", declarationKey: "daily-report" }),
      },
      undefined,
    );
  });

  it("rejects blank and oversized declaration keys", async () => {
    for (const declarationKey of ["   ", "x".repeat(201)]) {
      const { context, respond } = await invokeCronAdd(agentTurnCronParams({ declarationKey }));
      expect(context.cron.add).not.toHaveBeenCalled();
      expectResponseError(respond, { code: "INVALID_REQUEST" });
    }
  });

  it("rejects blank display names and invalid explicit enablement on cron.add", async () => {
    for (const overrides of [{ displayName: "   " }, { declarationKey: "daily", enabled: null }]) {
      const { context, respond } = await invokeCronAdd(agentTurnCronParams(overrides));
      expect(context.cron.add).not.toHaveBeenCalled();
      expectResponseError(respond, { code: "INVALID_REQUEST" });
    }
  });

  it("defaults session-target declarations to announce delivery", async () => {
    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({
        declarationKey: "session-report",
        sessionTarget: "session:agent:ops:main",
        agentId: "ops",
        delivery: undefined,
      }),
    );

    expect(requireCronAddPayload(context).delivery).toEqual({ mode: "announce" });
    expectCronSuccess(respond);
  });

  it("accepts webhook delivery for main-session adds and updates", async () => {
    // Shipped cron behavior: main-session jobs may deliver via webhook.
    const add = await invokeCronAdd({
      name: "main webhook",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "wake" },
      delivery: { mode: "webhook", to: "https://example.invalid/hook" },
    });
    expect(add.context.cron.add).toHaveBeenCalledTimes(1);
    expectCronSuccess(add.respond);

    const update = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: { delivery: { mode: "webhook", to: "https://example.invalid/hook" } },
      },
      createCronJob({
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "wake" },
      }),
    );
    expect(update.context.cron.update).toHaveBeenCalledTimes(1);
    expectCronSuccess(update.respond);
  });

  it("revalidates delivery against the locked cron.update snapshot", async () => {
    const currentJob = createCronJob();
    const context = createCronContext(currentJob);
    context.cron.updateWithPrecondition.mockImplementationOnce(
      async (_id, _patch, precondition) => {
        await precondition(
          createCronJob({
            sessionTarget: "main",
            payload: { kind: "systemEvent", text: "wake" },
          }),
          Date.now(),
        );
        return currentJob;
      },
    );
    const { respond } = await invokeCron(
      "cron.update",
      {
        id: "cron-1",
        // Channel/target provider mismatch fails announce validation without
        // any configured-channel dependency, so the locked-snapshot
        // revalidation path stays observable.
        patch: { delivery: { mode: "announce", channel: "discord", to: "telegram:123" } },
      },
      { context },
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, { messageIncludes: "delivery.channel" });
  });

  it("projects declaration metadata and existing run and delivery state in compact lists", async () => {
    const job = createCronJob({
      declarationKey: "daily-report",
      displayName: "Daily report",
      owner: { agentId: "ops", sessionKey: "agent:ops:main" },
      state: {
        nextRunAtMs: 2000,
        lastRunAtMs: 1000,
        lastRunStatus: "error",
        lastError: "boom",
        lastDelivered: false,
        lastDeliveryStatus: "not-delivered",
        lastDeliveryError: "offline",
        lastFailureNotificationDelivered: true,
        lastFailureNotificationDeliveryStatus: "delivered",
      },
    });
    const context = createCronContext(job);
    const { respond } = await invokeCron("cron.list", { compact: true }, { context });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        jobs: [
          expect.objectContaining({
            declarationKey: "daily-report",
            displayName: "Daily report",
            owner: { agentId: "ops", sessionKey: "agent:ops:main" },
            nextRunAtMs: 2000,
            lastRunAtMs: 1000,
            lastRunStatus: "error",
            lastRunError: "boom",
            lastDelivered: false,
            lastDeliveryStatus: "not-delivered",
            lastDeliveryError: "offline",
            lastFailureNotificationDelivered: true,
            lastFailureNotificationDeliveryStatus: "delivered",
          }),
        ],
      }),
      undefined,
    );
  });

  it("rejects caller-scoped cron.add for a foreign agent", async () => {
    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({
        agentId: "worker",
      }),
      { client: callerClient("ops") },
    );

    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "outside caller scope",
    });
  });

  it("rejects caller-scoped cron.add with a foreign agent-prefixed session target", async () => {
    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({
        agentId: "ops",
        sessionTarget: "session:agent:worker:telegram:direct:alice",
      }),
      { client: callerClient("ops") },
    );

    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "outside caller scope",
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

  it("allows caller-scoped cron.update for the same agent", async () => {
    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: { enabled: false },
      },
      createCronJob({ agentId: "ops" }),
      { client: callerClient("ops") },
    );

    expect(context.cron.update).toHaveBeenCalledWith("cron-1", { enabled: false });
    expectCronSuccess(respond);
  });

  it("allows cron.update to clear a display name", async () => {
    const { context, respond } = await invokeCronUpdate(
      { id: "cron-1", patch: { displayName: null } },
      createCronJob({ displayName: "Daily report" }),
    );

    expect(context.cron.update).toHaveBeenCalledWith("cron-1", { displayName: null });
    expectCronSuccess(respond);
  });

  it("rejects a blank cron.update display name", async () => {
    const { context, respond } = await invokeCronUpdate(
      { id: "cron-1", patch: { displayName: "   " } },
      createCronJob({ displayName: "Daily report" }),
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, { code: "INVALID_REQUEST", messageIncludes: "must not be blank" });
  });

  it("hides caller-scoped cron.update for a foreign agent", async () => {
    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: { enabled: false },
      },
      createCronJob({ agentId: "worker" }),
      { client: callerClient("ops") },
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "invalid cron.update params: id not found",
    });
  });

  it("rejects caller-scoped cron.update agentId retargeting", async () => {
    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: { agentId: "worker" },
      },
      createCronJob({ agentId: "ops" }),
      { client: callerClient("ops") },
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "agentId cannot be changed",
    });
  });

  it("rejects caller-scoped cron.update with a foreign sessionTarget", async () => {
    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: { sessionTarget: "session:agent:worker:telegram:direct:alice" },
      },
      createCronJob({ agentId: "ops" }),
      { client: callerClient("ops") },
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "session target outside caller scope",
    });
  });

  it("keeps unscoped cron.update agentId retargeting available for operator callers", async () => {
    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: { agentId: "worker" },
      },
      createCronJob({ agentId: "ops" }),
    );

    expect(context.cron.update).toHaveBeenCalledWith("cron-1", { agentId: "worker" });
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

  it("ignores stale ownerless channel config when validating default announce delivery", async () => {
    setRuntimeConfig({
      session: { mainKey: "main" },
      channels: {
        slack: {
          botToken: "xoxb-slack-token",
          appToken: "xapp-slack-token",
        },
        clickclack: {
          token: "stale-token",
        },
      },
      plugins: pluginEntries("slack"),
    } as OpenClawConfig);

    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({
        name: "ownerless config is not ambiguous",
        delivery: { mode: "announce" },
      }),
    );

    expect(context.cron.add).toHaveBeenCalled();
    expectCronSuccess(respond);
  });

  it("rejects explicit announce delivery to stale ownerless channel config", async () => {
    setRuntimeConfig({
      channels: {
        slack: {
          botToken: "xoxb-slack-token",
          appToken: "xapp-slack-token",
        },
        clickclack: {
          token: "stale-token",
        },
      },
      plugins: pluginEntries("slack"),
    } as OpenClawConfig);

    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({
        name: "ownerless channel is not deliverable",
        delivery: { mode: "announce", channel: "clickclack" },
      }),
    );

    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, { messageIncludes: "delivery.channel must be one of: slack" });
  });

  it("rejects explicit announce delivery when only stale ownerless channel config exists", async () => {
    setRuntimeConfig({
      channels: {
        clickclack: {
          token: "stale-token",
        },
      },
      plugins: pluginEntries(),
    } as OpenClawConfig);

    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({
        name: "only ownerless channel is not deliverable",
        delivery: { mode: "announce", channel: "clickclack" },
      }),
    );

    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, { messageIncludes: "delivery.channel is not configured" });
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

  it("accepts clearing an explicit channel back to runtime last", async () => {
    setRuntimeConfig(telegramSlackConfig());

    const { context, respond } = await invokeCronUpdateDelivery(
      { channel: null },
      createCronJob({
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      }),
    );

    expect(context.cron.update).toHaveBeenCalled();
    expectCronSuccess(respond);
  });

  it("validates a provider-prefixed target when clearing its explicit channel", async () => {
    setRuntimeConfig(slackConfig());

    const { context, respond } = await invokeCronUpdateDelivery(
      { channel: null },
      createCronJob({
        delivery: { mode: "announce", channel: "telegram", to: "telegram:123" },
      }),
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, { messageIncludes: "delivery.channel must be one of: slack" });
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
    await expectDefined(
      cronHandlers["cron.update"],
      'cronHandlers["cron.update"] test invariant',
    )({
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
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "cron-1" }),
      undefined,
    );
  });

  it("allows unrelated updates to legacy main-session webhook jobs", async () => {
    const { context, respond } = await invokeCronUpdate(
      { id: "cron-1", patch: { enabled: false } },
      createCronJob({
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "wake" },
        delivery: { mode: "webhook", to: "https://example.invalid/hook" },
      }),
    );

    expect(context.cron.update).toHaveBeenCalledWith("cron-1", { enabled: false });
    expectCronSuccess(respond);
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

  it("hides operator command cron jobs from caller-scoped cron.update", async () => {
    const context = createCronContext(
      createCronJob({
        id: "cron-1",
        agentId: "ops",
        payload: {
          kind: "command",
          argv: ["deploy"],
          env: { MARKER_ENV: "fixture-marker" },
        },
      }),
    );

    const { respond } = await invokeCron(
      "cron.update",
      { id: "cron-1", patch: { enabled: false } },
      { context, client: callerClient("ops") },
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "invalid cron.update params: id not found",
    });
  });

  it("returns INVALID_REQUEST when cron.run cannot find the job", async () => {
    const context = createCronContext();
    context.cron.enqueueRun.mockRejectedValueOnce(new Error("unknown cron job id: missing"));
    const { respond } = await invokeCron("cron.run", { id: "missing" }, { context });

    expect(context.cron.enqueueRun).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "invalid cron.run params: id not found",
    });
  });

  it("allows caller-scoped cron.run for the same agent", async () => {
    const context = createCronContext(createCronJob({ id: "cron-1", agentId: "ops" }));

    const { respond } = await invokeCron(
      "cron.run",
      { id: "cron-1", mode: "due" },
      { context, client: callerClient("ops") },
    );

    expect(context.cron.enqueueRun).toHaveBeenCalledWith("cron-1", "due");
    expect(respond).toHaveBeenCalledWith(
      true,
      { ok: true, enqueued: true, runId: "run-1" },
      undefined,
    );
  });

  it("hides caller-scoped cron.run for a foreign agent", async () => {
    const context = createCronContext(createCronJob({ id: "cron-1", agentId: "worker" }));

    const { respond } = await invokeCron(
      "cron.run",
      { jobId: "cron-1" },
      { context, client: callerClient("ops") },
    );

    expect(context.cron.enqueueRun).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "invalid cron.run params: id not found",
    });
  });

  it("does not enqueue same-agent command cron jobs from caller-scoped cron.run", async () => {
    const context = createCronContext(
      createCronJob({
        id: "cron-1",
        agentId: "ops",
        enabled: false,
        payload: {
          kind: "command",
          argv: ["deploy"],
          env: { MARKER_ENV: "fixture-marker" },
        },
      }),
    );

    const { respond } = await invokeCron(
      "cron.run",
      { id: "cron-1", mode: "force" },
      { context, client: callerClient("ops") },
    );

    expect(context.cron.enqueueRun).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "invalid cron.run params: id not found",
    });
  });

  it("rejects caller-scoped cron.runs all-scope history", async () => {
    const context = createCronContext(createCronJob({ id: "cron-1", agentId: "ops" }));

    const { respond } = await invokeCron(
      "cron.runs",
      { scope: "all" },
      { context, client: callerClient("ops") },
    );

    expect(context.cron.list).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "scope all is not allowed by caller scope",
    });
  });

  it("hides caller-scoped cron.runs for a foreign job", async () => {
    const context = createCronContext(createCronJob({ id: "cron-1", agentId: "worker" }));

    const { respond } = await invokeCron(
      "cron.runs",
      { id: "cron-1" },
      { context, client: callerClient("ops") },
    );

    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "invalid cron.runs params: id not found",
    });
  });

  it("hides operator command cron history from caller-scoped cron.runs", async () => {
    const context = createCronContext(
      createCronJob({
        id: "cron-1",
        agentId: "ops",
        payload: {
          kind: "command",
          argv: ["deploy"],
          env: { MARKER_ENV: "fixture-marker" },
        },
      }),
    );

    const { respond } = await invokeCron(
      "cron.runs",
      { id: "cron-1" },
      { context, client: callerClient("ops") },
    );

    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "invalid cron.runs params: id not found",
    });
  });

  it("re-throws non-parse errors from cron.add instead of masking as INVALID_REQUEST", async () => {
    const context = createCronContext();
    context.cron.add.mockRejectedValueOnce(new Error("DB write failed"));
    const respond = vi.fn();
    await expect(
      expectDefined(
        cronHandlers["cron.add"],
        'cronHandlers["cron.add"] test invariant',
      )({
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

    it("rejects a contradictory explicit agentId + agent-prefixed sessionKey pair", async () => {
      // The cron target resolver treats agentId as authoritative; a
      // contradictory pair would silently wake a lane the caller never named.
      const { context, respond } = await invokeWake({
        mode: "now",
        text: "ping",
        sessionKey: "agent:agent-456:discord:thread-xyz",
        agentId: "ops",
      });
      expect(context.cron.wake).not.toHaveBeenCalled();
      expectResponseError(respond, { code: "INVALID_REQUEST", messageIncludes: "contradicts" });
    });

    it("accepts an explicit agentId matching the agent that owns the sessionKey", async () => {
      const { context } = await invokeWake({
        mode: "now",
        text: "ping",
        sessionKey: "agent:agent-456:discord:thread-xyz",
        agentId: "agent-456",
      });
      expect(context.cron.wake).toHaveBeenCalledWith({
        mode: "now",
        text: "ping",
        sessionKey: "agent:agent-456:discord:thread-xyz",
        agentId: "agent-456",
      });
    });

    it.each([
      {
        name: "agentId",
        params: { agentId: "agent-456" },
        message: "wake agentId outside caller scope",
      },
      {
        name: "sessionKey",
        params: { sessionKey: "agent:agent-456:discord:thread-xyz" },
        message: "wake sessionKey outside caller scope",
      },
    ])("rejects a cross-agent $name for agent-runtime callers", async ({ params, message }) => {
      const { context, respond } = await invokeWake(
        { mode: "now", text: "ping", ...params },
        callerClient("agent-123"),
      );
      expect(context.cron.wake).not.toHaveBeenCalled();
      expectResponseError(respond, { code: "INVALID_REQUEST", messageIncludes: message });
    });

    it("binds agent-runtime wake calls to the calling agent", async () => {
      const { context, respond } = await invokeWake(
        {
          mode: "now",
          text: "ping",
          sessionKey: "agent:agent-123:discord:thread-xyz",
        },
        callerClient("agent-123"),
      );
      expect(context.cron.wake).toHaveBeenCalledWith({
        mode: "now",
        text: "ping",
        sessionKey: "agent:agent-123:discord:thread-xyz",
        agentId: "agent-123",
      });
      expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
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
