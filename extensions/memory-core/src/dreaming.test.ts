// Memory Core tests cover dreaming plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT,
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE,
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES,
  DEFAULT_MEMORY_DEEP_DREAMING_RECENCY_HALF_LIFE_DAYS,
  DEFAULT_MEMORY_DREAMING_FREQUENCY,
  MANAGED_MEMORY_DREAMING_CRON_NAME,
  MANAGED_MEMORY_DREAMING_CRON_TAG,
  MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
  resolveMemoryDeepDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  enqueueSystemEvent,
  resetSystemEventsForTest,
} from "openclaw/plugin-sdk/system-event-runtime";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerShortTermPromotionDreaming } from "./dreaming.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

// `runDreamingSweepPhases` is the only binding the dreaming trigger imports from this module.
const runDreamingSweepPhasesMock = vi.hoisted(() =>
  vi.fn(async (_params: { agentId?: string; workspaceDir: string }) => ({
    degradedPhases: 0,
    pendingNarratives: 0,
  })),
);
vi.mock("./dreaming-phases.js", () => ({
  runDreamingSweepPhases: runDreamingSweepPhasesMock,
}));

const constants = {
  MANAGED_DREAMING_CRON_NAME: MANAGED_MEMORY_DREAMING_CRON_NAME,
  MANAGED_DREAMING_CRON_TAG: MANAGED_MEMORY_DREAMING_CRON_TAG,
  DREAMING_SYSTEM_EVENT_TEXT: MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
  DEFAULT_DREAMING_CRON_EXPR: DEFAULT_MEMORY_DREAMING_FREQUENCY,
  DEFAULT_DREAMING_MIN_SCORE: DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE,
  DEFAULT_DREAMING_MIN_RECALL_COUNT: DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT,
  DEFAULT_DREAMING_MIN_UNIQUE_QUERIES: DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES,
  DEFAULT_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS:
    DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
  DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS: DEFAULT_MEMORY_DEEP_DREAMING_RECENCY_HALF_LIFE_DAYS,
  RUNTIME_CRON_RECONCILE_INTERVAL_MS: 60_000,
};
const { createTempWorkspace } = createMemoryCoreTestHarness();

const registeredServiceStops = new Set<() => Promise<void>>();

afterEach(async () => {
  const stops = [...registeredServiceStops];
  registeredServiceStops.clear();
  await Promise.all(stops.map((stop) => stop()));
  vi.useRealTimers();
  resetSystemEventsForTest();
});

type CronSchedule = { kind: "cron"; expr: string; tz?: string };
type CronPayload =
  | { kind: "systemEvent"; text: string }
  | { kind: "agentTurn"; message: string; lightContext?: boolean };
type CronAddInput = {
  declarationKey: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: CronSchedule;
  sessionTarget: "main" | "isolated";
  wakeMode: "now";
  payload: CronPayload;
  delivery?: { mode: "none" };
};
type CronPatch = Partial<CronAddInput>;
type CronJobLike = {
  id: string;
  declarationKey?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: { kind?: string; expr?: string; tz?: string };
  sessionTarget?: string;
  wakeMode?: string;
  payload?: { kind?: string; text?: string; message?: string; lightContext?: boolean };
  delivery?: { mode?: string };
  createdAtMs?: number;
};
type CronParam = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<CronJobLike[]>;
  add: (input: CronAddInput) => Promise<unknown>;
  update: (id: string, patch: CronPatch) => Promise<unknown>;
  remove: (id: string) => Promise<{ removed?: boolean }>;
  removeStaleJobFamily: (family: {
    declarationKey: string;
    name: string;
    ownerPluginTag: string;
  }) => Promise<number>;
};
type CronHarnessOptions = {
  listThrowsForFirstCalls?: number;
  removeResult?: "boolean" | "unknown";
  removeThrowsForIds?: string[];
  staleJobs?: CronJobLike[];
};
type DreamingPluginApi = Parameters<typeof registerShortTermPromotionDreaming>[0];
type DreamingPluginApiTestDouble = DreamingPluginApi & {
  logger: ReturnType<typeof createLogger>;
  on: ReturnType<typeof vi.fn>;
  registerService: ReturnType<typeof vi.fn<DreamingPluginApi["registerService"]>>;
};

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createCronHarness(initialJobs: CronJobLike[] = [], opts?: CronHarnessOptions) {
  const jobs: CronJobLike[] = [...initialJobs];
  const staleJobs: CronJobLike[] = [...(opts?.staleJobs ?? [])];
  let listCalls = 0;
  const addCalls: CronAddInput[] = [];
  const updateCalls: Array<{ id: string; patch: CronPatch }> = [];
  const removeCalls: string[] = [];
  const mutationCalls: string[] = [];
  const staleFamilyCalls: Array<{
    declarationKey: string;
    name: string;
    ownerPluginTag: string;
  }> = [];

  const cron: CronParam = {
    async list() {
      listCalls += 1;
      if (opts?.listThrowsForFirstCalls && listCalls <= opts.listThrowsForFirstCalls) {
        throw new Error(`list failed on call ${listCalls}`);
      }
      return jobs.map((job) => ({
        ...job,
        ...(job.schedule ? { schedule: { ...job.schedule } } : {}),
        ...(job.payload ? { payload: { ...job.payload } } : {}),
        ...(job.delivery ? { delivery: { ...job.delivery } } : {}),
      }));
    },
    async add(input) {
      mutationCalls.push("add");
      addCalls.push(input);
      jobs.push({
        id: `job-${jobs.length + 1}`,
        declarationKey: input.declarationKey,
        name: input.name,
        description: input.description,
        enabled: input.enabled,
        schedule: { ...input.schedule },
        sessionTarget: input.sessionTarget,
        wakeMode: input.wakeMode,
        payload: { ...input.payload },
        ...(input.delivery ? { delivery: { ...input.delivery } } : {}),
        createdAtMs: Date.now(),
      });
      return {};
    },
    async update(id, patch) {
      mutationCalls.push(`update:${id}`);
      updateCalls.push({ id, patch });
      const index = jobs.findIndex((entry) => entry.id === id);
      if (index < 0) {
        return {};
      }
      const current = expectDefined(jobs[index], `managed cron job ${id}`);
      jobs[index] = {
        ...current,
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.description ? { description: patch.description } : {}),
        ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
        ...(patch.schedule ? { schedule: { ...patch.schedule } } : {}),
        ...(patch.sessionTarget ? { sessionTarget: patch.sessionTarget } : {}),
        ...(patch.wakeMode ? { wakeMode: patch.wakeMode } : {}),
        ...(patch.payload ? { payload: { ...patch.payload } } : {}),
        ...(patch.delivery ? { delivery: { ...patch.delivery } } : {}),
      };
      return {};
    },
    async remove(id) {
      mutationCalls.push(`remove:${id}`);
      removeCalls.push(id);
      if (opts?.removeThrowsForIds?.includes(id)) {
        throw new Error(`remove failed for ${id}`);
      }
      const index = jobs.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        jobs.splice(index, 1);
      }
      if (opts?.removeResult === "unknown") {
        return {};
      }
      return { removed: index >= 0 };
    },
    async removeStaleJobFamily(family) {
      staleFamilyCalls.push(family);
      const retained = staleJobs.filter(
        (job) =>
          job.declarationKey !== family.declarationKey &&
          !(job.name === family.name && job.description?.includes(family.ownerPluginTag) === true),
      );
      const removed = staleJobs.length - retained.length;
      staleJobs.splice(0, staleJobs.length, ...retained);
      return removed;
    },
  };

  return {
    cron,
    jobs,
    staleJobs,
    addCalls,
    updateCalls,
    removeCalls,
    mutationCalls,
    staleFamilyCalls,
    get listCalls() {
      return listCalls;
    },
  };
}

function createDreamingConfig(
  dreaming: Record<string, unknown> = {
    enabled: true,
    frequency: "15 4 * * *",
    timezone: "UTC",
  },
  config: Partial<OpenClawConfig> = {},
): OpenClawConfig {
  return {
    ...config,
    plugins: {
      entries: {
        "memory-core": { config: { dreaming } },
      },
    },
  } as OpenClawConfig;
}

function createDreamingTestContext(
  params: {
    config?: OpenClawConfig;
    runtime?: { config?: Pick<DreamingPluginApi["runtime"]["config"], "current"> };
    initialJobs?: CronJobLike[];
    cronOptions?: CronHarnessOptions;
  } = {},
) {
  const logger = createLogger();
  const harness = createCronHarness(params.initialJobs, params.cronOptions);
  const onMock = vi.fn();
  const api: DreamingPluginApiTestDouble = {
    ...createTestPluginApi({
      config: params.config ?? createDreamingConfig(),
      pluginConfig: {},
      logger,
    }),
    logger,
    on: onMock,
    registerService: vi.fn<DreamingPluginApi["registerService"]>(),
  };
  Object.assign(api.runtime, params.runtime);
  return { api, harness, logger };
}

function mockStringMessages(mock: { mock: { calls: unknown[][] } }): string[] {
  return mock.mock.calls.map((call) => {
    const message = call[0];
    return typeof message === "string" ? message : "";
  });
}

function expectLogContains(mock: { mock: { calls: unknown[][] } }, expected: string): void {
  expect(mockStringMessages(mock).join("\n")).toContain(expected);
}

function expectLogNotContains(mock: { mock: { calls: unknown[][] } }, expected: string): void {
  expect(mockStringMessages(mock).join("\n")).not.toContain(expected);
}

function requireAddCall(harness: { addCalls: CronAddInput[] }, index: number): CronAddInput {
  const call = harness.addCalls[index];
  if (!call) {
    throw new Error(`expected cron add call ${index}`);
  }
  return call;
}

function requireAgentTurnPayload(
  payload: CronAddInput["payload"],
): Extract<CronAddInput["payload"], { kind: "agentTurn" }> {
  if (payload.kind !== "agentTurn") {
    throw new Error(`expected agentTurn payload, got ${payload.kind}`);
  }
  return payload;
}

function expectCronSchedule(
  schedule: CronAddInput["schedule"] | CronPatch["schedule"] | undefined,
  expr: string,
  tz?: string,
): void {
  expect(schedule?.kind).toBe("cron");
  expect(schedule?.expr).toBe(expr);
  expect(schedule?.tz).toBe(tz);
}

function getBeforeAgentReplyHandler(
  onMock: ReturnType<typeof vi.fn>,
): (
  event: { cleanedBody: string },
  ctx: { agentId?: string; trigger?: string; workspaceDir?: string; sessionKey?: string },
) => Promise<unknown> {
  const call = onMock.mock.calls.find(([eventName]) => eventName === "before_agent_reply");
  if (!call) {
    throw new Error("before_agent_reply hook was not registered");
  }
  return call[1] as (
    event: { cleanedBody: string },
    ctx: { agentId?: string; trigger?: string; workspaceDir?: string; sessionKey?: string },
  ) => Promise<unknown>;
}

function getDreamingService(api: DreamingPluginApiTestDouble) {
  return expectDefined(
    api.registerService.mock.calls.find(([service]) => service.id === "memory-core-dreaming"),
    "memory-core-dreaming service registration",
  )[0];
}

async function triggerDreamingServiceStart(
  api: DreamingPluginApiTestDouble,
  ctx: { config: OpenClawConfig; workspaceDir?: string; getCron?: () => unknown },
): Promise<void> {
  await getDreamingService(api).start({
    ...ctx,
    stateDir: ".",
    logger: api.logger,
  } as OpenClawPluginServiceContext);
}

async function triggerDreamingServiceStop(api: DreamingPluginApiTestDouble): Promise<void> {
  await getDreamingService(api).stop?.({
    config: api.config,
    stateDir: ".",
    logger: api.logger,
  });
}

function registerShortTermPromotionDreamingForTest(api: DreamingPluginApiTestDouble): void {
  registerShortTermPromotionDreaming(api);
  registeredServiceStops.add(() => triggerDreamingServiceStop(api));
}

describe("short-term dreaming config", () => {
  it.each([
    { name: "blank", value: " " },
    { name: "negative", value: -2 },
  ])("keeps deep defaults for $name thresholds", ({ value }) => {
    const resolved = resolveMemoryDeepDreamingConfig({
      pluginConfig: {
        dreaming: {
          phases: {
            deep: {
              minScore: value,
              minRecallCount: value,
              minUniqueQueries: value,
              recencyHalfLifeDays: value,
              maxAgeDays: value,
              maxPromotedSnippetTokens: value,
            },
          },
        },
      },
    });
    expect(resolved).toMatchObject({
      minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
      minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
      minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
      recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
      maxAgeDays: 30,
      maxPromotedSnippetTokens: constants.DEFAULT_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
    });
  });

  it.each([
    { name: "zero promotion cap", deep: { limit: 0 }, expected: { limit: 0 } },
    { name: "disabled deep phase", deep: { enabled: false }, expected: { enabled: false } },
  ])("preserves an explicit $name", ({ deep, expected }) => {
    expect(
      resolveMemoryDeepDreamingConfig({ pluginConfig: { dreaming: { phases: { deep } } } }),
    ).toMatchObject(expected);
  });
});

describe("dreaming service reconciliation", () => {
  let liveConfigRunPayloadCase: {
    result: unknown;
    runtimeConfigCalled: boolean;
    warnCalls: unknown[][];
  };

  beforeAll(async () => {
    const workspaceDir = await createTempWorkspace("memory-dreaming-live-config-workspace-");
    const runtimeCurrentConfig = vi.fn(() =>
      createDreamingConfig(
        { enabled: true, frequency: "15 4 * * *", timezone: "UTC", limit: 0 },
        { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
      ),
    );
    const { api, harness, logger } = createDreamingTestContext({
      config: createDreamingConfig({
        enabled: true,
        frequency: "15 4 * * *",
        timezone: "UTC",
        limit: 5,
      }),
      runtime: { config: { current: runtimeCurrentConfig } },
    });

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerDreamingServiceStart(api, {
        config: api.config,
        getCron: () => harness.cron,
      });

      const sessionKey = "agent:main:main";
      enqueueSystemEvent(constants.DREAMING_SYSTEM_EVENT_TEXT, {
        sessionKey,
        contextKey: "cron:memory-dreaming",
      });

      const beforeAgentReply = getBeforeAgentReplyHandler(api.on);
      liveConfigRunPayloadCase = {
        result: await beforeAgentReply(
          { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
          { trigger: "heartbeat", sessionKey },
        ),
        runtimeConfigCalled: runtimeCurrentConfig.mock.calls.length > 0,
        warnCalls: [...logger.warn.mock.calls],
      };
    } finally {
      await triggerDreamingServiceStop(api).catch(() => undefined);
    }
  });

  it("uses the startup cfg when reconciling the managed dreaming cron job", async () => {
    const { api, harness, logger } = createDreamingTestContext({
      config: { plugins: { entries: {} } },
    });

    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, {
      config: {
        hooks: { internal: { enabled: true } },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  frequency: "15 4 * * *",
                  timezone: "UTC",
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      getCron: () => harness.cron,
    });

    expect(harness.addCalls).toHaveLength(1);
    const addCall = requireAddCall(harness, 0);
    expect(addCall.declarationKey).toBe("memory-core:memory-dreaming-promotion");
    expectCronSchedule(addCall.schedule, "15 4 * * *", "UTC");
    expect(addCall.delivery?.mode).toBe("none");
    expectLogContains(logger.info, "created managed dreaming cron job");
  });

  it("recovers on the runtime interval after startup cron reconciliation fails", async () => {
    vi.useFakeTimers();
    const { api, harness, logger } = createDreamingTestContext({
      cronOptions: { listThrowsForFirstCalls: 1 },
    });

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerDreamingServiceStart(api, {
        config: api.config,
        getCron: () => harness.cron,
      });

      expect(harness.listCalls).toBe(1);
      expect(harness.addCalls).toHaveLength(0);
      expectLogContains(logger.error, "dreaming startup reconciliation failed");

      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);

      expect(harness.listCalls).toBe(2);
      expect(harness.addCalls).toHaveLength(1);
      expectCronSchedule(requireAddCall(harness, 0).schedule, "15 4 * * *", "UTC");
    } finally {
      await triggerDreamingServiceStop(api).catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("drains pending reconciliation on service stop without arming runtime recovery", async () => {
    vi.useFakeTimers();
    let rejectStartupList: (reason?: unknown) => void = () => undefined;
    const startupListPromise = new Promise<CronJobLike[]>((_resolve, reject) => {
      rejectStartupList = reject;
    });
    let listCalls = 0;
    const addCalls: CronAddInput[] = [];
    const cron: CronParam = {
      async list() {
        listCalls += 1;
        if (listCalls === 1) {
          return startupListPromise;
        }
        return [];
      },
      async add(input) {
        addCalls.push(input);
        return {};
      },
      async update() {
        return {};
      },
      async remove() {
        return { removed: false };
      },
      async removeStaleJobFamily() {
        return 0;
      },
    };
    const { api, logger } = createDreamingTestContext();

    try {
      registerShortTermPromotionDreamingForTest(api);
      const startup = triggerDreamingServiceStart(api, {
        config: api.config,
        getCron: () => cron,
      });

      let stopped = false;
      const stopping = triggerDreamingServiceStop(api).then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      rejectStartupList(new Error("startup list failed"));
      await Promise.all([startup, stopping]);
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);

      expect(listCalls).toBe(1);
      expect(addCalls).toHaveLength(0);
      expectLogContains(logger.error, "dreaming startup reconciliation failed");
    } finally {
      rejectStartupList(new Error("test cleanup"));
      await triggerDreamingServiceStop(api).catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("updates the existing job on service replacement and stops the old reconciliation timer", async () => {
    vi.useFakeTimers();
    const { api, harness } = createDreamingTestContext({
      config: createDreamingConfig({ enabled: true, frequency: "0 1 * * *", timezone: "UTC" }),
    });
    const { api: successorApi } = createDreamingTestContext({
      config: createDreamingConfig({
        enabled: true,
        frequency: "45 8 * * *",
        timezone: "America/Los_Angeles",
      }),
    });

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerDreamingServiceStart(api, { config: api.config, getCron: () => harness.cron });
      const originalId = expectDefined(harness.jobs[0], "original dreaming job").id;

      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS / 2);
      await triggerDreamingServiceStop(api);
      registerShortTermPromotionDreamingForTest(successorApi);
      await triggerDreamingServiceStart(successorApi, {
        config: successorApi.config,
        getCron: () => harness.cron,
      });

      expect(harness.addCalls).toHaveLength(1);
      expect(harness.updateCalls).toEqual([
        {
          id: originalId,
          patch: {
            schedule: { kind: "cron", expr: "45 8 * * *", tz: "America/Los_Angeles" },
          },
        },
      ]);
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS * 2);

      expect(harness.listCalls).toBe(4);
      expect(harness.updateCalls).toHaveLength(1);
      expect(harness.jobs).toHaveLength(1);
      expect(harness.jobs[0]).toMatchObject({
        id: originalId,
        schedule: { kind: "cron", expr: "45 8 * * *", tz: "America/Los_Angeles" },
      });

      await triggerDreamingServiceStop(successorApi);
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);
      expect(harness.listCalls).toBe(4);
    } finally {
      await triggerDreamingServiceStop(api);
      await triggerDreamingServiceStop(successorApi);
      vi.useRealTimers();
    }
  });

  it("reconciles disabled->enabled config changes without waiting for another agent turn", async () => {
    vi.useFakeTimers();
    const { api, harness } = createDreamingTestContext({
      config: createDreamingConfig({ enabled: false, frequency: "0 2 * * *", timezone: "UTC" }),
    });

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerDreamingServiceStart(api, {
        config: api.config,
        getCron: () => harness.cron,
      });

      expect(harness.addCalls).toHaveLength(0);

      api.config = createDreamingConfig({
        enabled: true,
        frequency: "30 6 * * *",
        timezone: "America/New_York",
      });

      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);

      expect(harness.addCalls).toHaveLength(1);
      expectCronSchedule(requireAddCall(harness, 0).schedule, "30 6 * * *", "America/New_York");
    } finally {
      await triggerDreamingServiceStop(api).catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("replaces a legacy name-matched job with its declared identity", async () => {
    const { api, harness } = createDreamingTestContext({
      config: createDreamingConfig({ enabled: true, frequency: "*/3 * * * *" }),
      initialJobs: [
        {
          id: "job-old-schedule",
          name: constants.MANAGED_DREAMING_CRON_NAME,
          description: `${constants.MANAGED_DREAMING_CRON_TAG} legacy managed dreaming job`,
          enabled: true,
          schedule: { kind: "cron", expr: "0 3 * * *" },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "legacy-dreaming-payload" },
          delivery: { mode: "none" },
          createdAtMs: 10,
        },
      ],
    });

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerDreamingServiceStart(api, { config: api.config, getCron: () => harness.cron });

      expect(harness.addCalls).toHaveLength(1);
      expect(harness.removeCalls).toEqual(["job-old-schedule"]);
      expect(harness.mutationCalls).toEqual(["add", "remove:job-old-schedule"]);
      expect(harness.updateCalls).toHaveLength(0);
      expect(requireAddCall(harness, 0).declarationKey).toBe(
        "memory-core:memory-dreaming-promotion",
      );
      expectCronSchedule(requireAddCall(harness, 0).schedule, "*/3 * * * *");
      expect(harness.jobs).toHaveLength(1);
    } finally {
      await triggerDreamingServiceStop(api).catch(() => undefined);
    }
  });

  it("replaces legacy managed duplicates with one declared job", async () => {
    const seeded = (id: string, createdAtMs: number, expr: string): CronJobLike => ({
      id,
      name: constants.MANAGED_DREAMING_CRON_NAME,
      description: `${constants.MANAGED_DREAMING_CRON_TAG} legacy managed dreaming job`,
      enabled: true,
      schedule: { kind: "cron", expr },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "legacy-dreaming-payload" },
      delivery: { mode: "none" },
      createdAtMs,
    });
    const { api, harness } = createDreamingTestContext({
      config: createDreamingConfig({ enabled: true, frequency: "*/3 * * * *" }),
      initialJobs: [
        seeded("job-oldest", 10, "0 3 * * *"),
        seeded("job-duplicate", 20, "*/5 * * * *"),
      ],
    });

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerDreamingServiceStart(api, { config: api.config, getCron: () => harness.cron });

      expect(harness.addCalls).toHaveLength(1);
      expect(harness.removeCalls).toEqual(["job-oldest", "job-duplicate"]);
      expect(harness.updateCalls).toHaveLength(0);
      expectCronSchedule(requireAddCall(harness, 0).schedule, "*/3 * * * *");
      expect(harness.jobs).toHaveLength(1);
      expect(harness.jobs[0]?.declarationKey).toBe("memory-core:memory-dreaming-promotion");
    } finally {
      await triggerDreamingServiceStop(api).catch(() => undefined);
    }
  });

  it("adopts the exact legacy row from an obsolete store beside the declaration job", async () => {
    const legacyRow: CronJobLike = {
      id: "75e182e6-8728-43ae-832b-01f50702feed",
      name: "Memory Dreaming Promotion",
      description:
        "[managed-by=memory-core.short-term-promotion] Promote weighted short-term recalls into MEMORY.md (limit=10, minScore=0.800, minRecallCount=3, minUniqueQueries=3, recencyHalfLifeDays=14, maxAgeDays=30).",
      enabled: true,
      schedule: { kind: "cron", expr: "0 3 * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: constants.DREAMING_SYSTEM_EVENT_TEXT,
        lightContext: true,
      },
      createdAtMs: 1_785_240_959_377,
    };
    const declaredRow: CronJobLike = {
      id: "job-declared",
      declarationKey: "memory-core:memory-dreaming-promotion",
      name: "Memory Dreaming Promotion",
      description: `${constants.MANAGED_DREAMING_CRON_TAG} current managed dreaming job`,
      enabled: true,
      schedule: { kind: "cron", expr: "*/3 * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: constants.DREAMING_SYSTEM_EVENT_TEXT,
        lightContext: true,
      },
      delivery: { mode: "none" },
      createdAtMs: 1_785_338_313_079,
    };
    const { api, harness } = createDreamingTestContext({
      config: createDreamingConfig({ enabled: true, frequency: "*/3 * * * *" }),
      initialJobs: [declaredRow],
      cronOptions: { staleJobs: [legacyRow] },
    });

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerDreamingServiceStart(api, { config: api.config, getCron: () => harness.cron });

      expect(harness.staleJobs).toEqual([]);
      expect(harness.jobs).toHaveLength(1);
      expect(harness.jobs[0]).toMatchObject({
        declarationKey: "memory-core:memory-dreaming-promotion",
        name: "Memory Dreaming Promotion",
        enabled: true,
        schedule: { kind: "cron", expr: "*/3 * * * *" },
      });
      expect(harness.staleFamilyCalls).toEqual([
        {
          declarationKey: "memory-core:memory-dreaming-promotion",
          name: "Memory Dreaming Promotion",
          ownerPluginTag: constants.MANAGED_DREAMING_CRON_TAG,
        },
      ]);
    } finally {
      await triggerDreamingServiceStop(api).catch(() => undefined);
    }
  });

  it("recreates a deleted managed job on the regular interval without an agent turn", async () => {
    vi.useFakeTimers();
    const { api, harness } = createDreamingTestContext({
      config: createDreamingConfig({ enabled: true, frequency: "0 2 * * *", timezone: "UTC" }),
    });

    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, {
      config: api.config,
      getCron: () => harness.cron,
    });
    expect(harness.addCalls).toHaveLength(1);

    harness.jobs.splice(
      0,
      harness.jobs.length,
      ...harness.jobs.filter(
        (job) => !job.description?.includes("[managed-by=memory-core.short-term-promotion]"),
      ),
    );
    expect(harness.jobs).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);

    expect(harness.addCalls).toHaveLength(2);
    expectCronSchedule(requireAddCall(harness, 1).schedule, "0 2 * * *", "UTC");
  });

  it("keeps scheduler maintenance out of user, heartbeat, and cron reply hooks", async () => {
    const { api, harness } = createDreamingTestContext({
      config: createDreamingConfig({ enabled: true, frequency: "0 2 * * *", timezone: "UTC" }),
    });

    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, {
      config: api.config,
      getCron: () => harness.cron,
    });

    expect(harness.listCalls).toBe(1);

    const beforeAgentReply = getBeforeAgentReplyHandler(api.on);
    await beforeAgentReply({ cleanedBody: "hello" }, { trigger: "user", workspaceDir: "." });
    await beforeAgentReply({ cleanedBody: "" }, { trigger: "heartbeat", workspaceDir: "." });
    await beforeAgentReply({ cleanedBody: "" }, { trigger: "cron", workspaceDir: "." });

    expect(harness.listCalls).toBe(1);
  });

  it("only triggers managed dreaming when the queued cron event is still pending", async () => {
    const { api, harness } = createDreamingTestContext({
      config: createDreamingConfig({ enabled: false }),
    });

    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, {
      config: api.config,
      getCron: () => harness.cron,
    });

    const sessionKey = "agent:main:main";
    enqueueSystemEvent(constants.DREAMING_SYSTEM_EVENT_TEXT, {
      sessionKey,
      contextKey: "cron:memory-dreaming",
    });

    const beforeAgentReply = getBeforeAgentReplyHandler(api.on);
    const first = await beforeAgentReply(
      { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
      { trigger: "heartbeat", workspaceDir: ".", sessionKey },
    );

    expect(first).toEqual({
      handled: true,
      reason: "memory-core: short-term dreaming disabled",
    });

    resetSystemEventsForTest();

    const second = await beforeAgentReply(
      { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
      { trigger: "heartbeat", workspaceDir: ".", sessionKey },
    );

    expect(second).toBeUndefined();
  });

  it("resolves queued managed dreaming cron events from the base session for isolated heartbeats", async () => {
    const { api, harness } = createDreamingTestContext({
      config: createDreamingConfig({ enabled: false }),
    });

    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, {
      config: api.config,
      getCron: () => harness.cron,
    });

    enqueueSystemEvent(constants.DREAMING_SYSTEM_EVENT_TEXT, {
      sessionKey: "agent:main:main",
      contextKey: "cron:memory-dreaming",
    });

    const beforeAgentReply = getBeforeAgentReplyHandler(api.on);
    const result = await beforeAgentReply(
      { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
      { trigger: "heartbeat", workspaceDir: ".", sessionKey: "agent:main:main:heartbeat" },
    );

    expect(result).toEqual({
      handled: true,
      reason: "memory-core: short-term dreaming disabled",
    });
  });

  it("does not emit the cron-unavailable warning at service start when cron is missing", async () => {
    const { api, logger } = createDreamingTestContext({
      config: { plugins: { entries: {} } },
    });

    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, {
      config: createDreamingConfig(undefined, { hooks: { internal: { enabled: true } } }),
      getCron: () => undefined,
    });

    expectLogNotContains(logger.warn, "cron service unavailable");
    expectLogContains(logger.debug, "cron service not yet available at service start");
  });

  it("does not start background reconciliation in a host without Gateway cron access", async () => {
    vi.useFakeTimers();
    const { api, harness, logger } = createDreamingTestContext();

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerDreamingServiceStart(api, { config: api.config });
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS * 2);

      expect(harness.listCalls).toBe(0);
      expect(logger.debug).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await triggerDreamingServiceStop(api);
      vi.useRealTimers();
    }
  });

  it("ignores ordinary heartbeats before the Gateway service starts", async () => {
    const { api, logger } = createDreamingTestContext();

    registerShortTermPromotionDreamingForTest(api);

    const beforeAgentReply = getBeforeAgentReplyHandler(api.on);
    await beforeAgentReply(
      { cleanedBody: "" },
      { trigger: "heartbeat", workspaceDir: ".", sessionKey: "agent:main:main:heartbeat" },
    );

    expectLogNotContains(logger.warn, "cron service unavailable");
  });

  it("recovers unavailable cron on the regular interval without a heartbeat or repeated warnings", async () => {
    vi.useFakeTimers();
    const { api, harness, logger } = createDreamingTestContext();

    try {
      registerShortTermPromotionDreamingForTest(api);
      let cronAvailable = false;
      await triggerDreamingServiceStart(api, {
        config: api.config,
        getCron: () => (cronAvailable ? harness.cron : undefined),
      });

      expect(harness.addCalls).toHaveLength(0);
      expectLogContains(logger.debug, "cron service not yet available at service start");

      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);
      expect(harness.addCalls).toHaveLength(0);
      expectLogContains(logger.warn, "cron service unavailable");
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);
      expect(logger.warn).toHaveBeenCalledTimes(1);

      cronAvailable = true;
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);

      expect(harness.addCalls).toHaveLength(1);
      const addCall = requireAddCall(harness, 0);
      expect(addCall.name).toBe("Memory Dreaming Promotion");
      expectCronSchedule(addCall.schedule, "15 4 * * *", "UTC");
      expect(addCall.sessionTarget).toBe("isolated");
      const payload = requireAgentTurnPayload(addCall.payload);
      expect(payload.message).toBe(constants.DREAMING_SYSTEM_EVENT_TEXT);
      expect(payload.lightContext).toBe(true);
    } finally {
      await triggerDreamingServiceStop(api);
      vi.useRealTimers();
    }
  });

  it("removes disabled dreaming jobs when cron becomes available on the regular interval", async () => {
    vi.useFakeTimers();
    const managedJob: CronJobLike = {
      id: "job-managed",
      declarationKey: "memory-core:memory-dreaming-promotion",
      name: "Historical Dreaming Promotion Name",
      description: `${constants.MANAGED_DREAMING_CRON_TAG} test`,
      enabled: true,
      schedule: { kind: "cron", expr: "0 3 * * *" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: constants.DREAMING_SYSTEM_EVENT_TEXT },
      createdAtMs: 10,
    };
    const { api, harness, logger } = createDreamingTestContext({
      config: createDreamingConfig({
        enabled: false,
        frequency: "15 4 * * *",
        timezone: "UTC",
      }),
      initialJobs: [managedJob],
    });

    try {
      registerShortTermPromotionDreamingForTest(api);
      let cronAvailable = false;
      await triggerDreamingServiceStart(api, {
        config: api.config,
        getCron: () => (cronAvailable ? harness.cron : undefined),
      });

      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);
      expect(harness.removeCalls).toHaveLength(0);

      cronAvailable = true;
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);

      expect(harness.removeCalls).toEqual(["job-managed"]);
      expect(harness.jobs).toHaveLength(0);
      expect(harness.addCalls).toHaveLength(0);
      expectLogContains(logger.info, "removed 1 managed dreaming cron job");
    } finally {
      await triggerDreamingServiceStop(api);
      vi.useRealTimers();
    }
  });

  it("does not recreate startup cron from stale enabled config after runtime config disables dreaming", async () => {
    vi.useFakeTimers();
    const { api, harness, logger } = createDreamingTestContext({
      cronOptions: { listThrowsForFirstCalls: 1 },
    });

    try {
      registerShortTermPromotionDreamingForTest(api);
      let cronAvailable = false;
      await triggerDreamingServiceStart(api, {
        config: api.config,
        getCron: () => (cronAvailable ? harness.cron : undefined),
      });

      api.config = createDreamingConfig({
        enabled: false,
        frequency: "15 4 * * *",
        timezone: "UTC",
      });
      cronAvailable = true;

      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);

      expectLogContains(logger.error, "dreaming cron reconcile failed");
      expect(harness.listCalls).toBe(2);
      expect(harness.addCalls).toHaveLength(0);
    } finally {
      await triggerDreamingServiceStop(api);
      vi.useRealTimers();
    }
  });

  it("uses default-on cadence instead of stale startup config when live memory-core config is removed", async () => {
    vi.useFakeTimers();
    const runtimeCurrentConfig = vi.fn(
      () =>
        ({
          plugins: {
            entries: {},
          },
        }) as OpenClawConfig,
    );
    const { api, harness, logger } = createDreamingTestContext({
      runtime: { config: { current: runtimeCurrentConfig } },
    });

    try {
      registerShortTermPromotionDreamingForTest(api);
      let cronAvailable = false;
      await triggerDreamingServiceStart(api, {
        config: api.config,
        getCron: () => (cronAvailable ? harness.cron : undefined),
      });

      cronAvailable = true;
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);

      expect(runtimeCurrentConfig).toHaveBeenCalled();
      expect(harness.addCalls).toHaveLength(1);
      expect(harness.addCalls[0]?.schedule.expr).toBe(constants.DEFAULT_DREAMING_CRON_EXPR);
      expectLogNotContains(logger.warn, "cron service unavailable");
    } finally {
      await triggerDreamingServiceStop(api).catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("stops unavailable-cron recovery when the service stops", async () => {
    vi.useFakeTimers();
    const { api, harness } = createDreamingTestContext();

    try {
      registerShortTermPromotionDreamingForTest(api);
      let cronAvailable = false;
      await triggerDreamingServiceStart(api, {
        config: api.config,
        getCron: () => (cronAvailable ? harness.cron : undefined),
      });

      await triggerDreamingServiceStop(api);
      cronAvailable = true;
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS * 2);

      expect(harness.addCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses live runtime config to disable a queued heartbeat dreaming run", async () => {
    const runtimeCurrentConfig = vi.fn(() => createDreamingConfig({ enabled: false }));
    const { api, harness } = createDreamingTestContext({
      runtime: { config: { current: runtimeCurrentConfig } },
    });

    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, {
      config: api.config,
      getCron: () => harness.cron,
    });

    const sessionKey = "agent:main:main";
    enqueueSystemEvent(constants.DREAMING_SYSTEM_EVENT_TEXT, {
      sessionKey,
      contextKey: "cron:memory-dreaming",
    });

    const beforeAgentReply = getBeforeAgentReplyHandler(api.on);
    const result = await beforeAgentReply(
      { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
      { trigger: "heartbeat", workspaceDir: ".", sessionKey },
    );

    expect(runtimeCurrentConfig).toHaveBeenCalled();
    expect(result).toEqual({
      handled: true,
      reason: "memory-core: short-term dreaming disabled",
    });
  });

  it("uses live runtime config for the heartbeat dreaming run payload", async () => {
    expect(liveConfigRunPayloadCase.result).toEqual({
      handled: true,
      reason: "memory-core: short-term dreaming processed",
    });
    expect(liveConfigRunPayloadCase.runtimeConfigCalled).toBe(true);
    expect(liveConfigRunPayloadCase.warnCalls).not.toContainEqual([
      "memory-core: dreaming promotion skipped because no memory workspace is available.",
    ]);
  });

  it("uses the product default instead of startup plugin config when live config is removed", async () => {
    const workspaceDir = await createTempWorkspace("memory-dreaming-default-on-live-config-");
    const runtimeCurrentConfig = vi.fn(
      () =>
        ({
          agents: {
            defaults: { workspace: workspaceDir },
            list: [{ id: "main", default: true, workspace: workspaceDir }],
          },
        }) as OpenClawConfig,
    );
    const { api, harness } = createDreamingTestContext({
      runtime: { config: { current: runtimeCurrentConfig } },
    });

    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, {
      config: api.config,
      getCron: () => harness.cron,
    });

    const sessionKey = "agent:main:main";
    enqueueSystemEvent(constants.DREAMING_SYSTEM_EVENT_TEXT, {
      sessionKey,
      contextKey: "cron:memory-dreaming",
    });

    const beforeAgentReply = getBeforeAgentReplyHandler(api.on);
    const result = await beforeAgentReply(
      { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
      { trigger: "heartbeat", workspaceDir, sessionKey },
    );

    expect(runtimeCurrentConfig).toHaveBeenCalled();
    expect(result).toEqual({
      handled: true,
      reason: "memory-core: short-term dreaming processed",
    });
  });

  it("handles managed dreaming cron triggers without a queued heartbeat event", async () => {
    const { api, harness } = createDreamingTestContext({
      config: createDreamingConfig({ enabled: false }),
    });

    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, {
      config: api.config,
      getCron: () => harness.cron,
    });

    const beforeAgentReply = getBeforeAgentReplyHandler(api.on);
    const result = await beforeAgentReply(
      { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
      { trigger: "cron", workspaceDir: ".", sessionKey: "cron:memory-dreaming" },
    );

    expect(result).toEqual({
      handled: true,
      reason: "memory-core: short-term dreaming disabled",
    });
  });

  // Regression: the sweep dropped the agent id entirely, so narrative subagent sessions used
  // unscoped keys that no per-agent SQLite store could resolve and every phase failed.
  it("sweeps each workspace as its owning agent rather than the roster default", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-owner-");
    runDreamingSweepPhasesMock.mockClear();
    const { api, harness } = createDreamingTestContext({
      config: createDreamingConfig(
        {
          enabled: true,
          limit: 5,
          phases: { light: { enabled: false }, rem: { enabled: false } },
        },
        { agents: { defaults: { workspace: workspaceDir } } },
      ),
    });

    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, {
      config: api.config,
      getCron: () => harness.cron,
    });

    const beforeAgentReply = getBeforeAgentReplyHandler(api.on);
    await beforeAgentReply(
      { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
      {
        trigger: "cron",
        agentId: "researcher",
        workspaceDir,
        sessionKey: "agent:researcher:cron:memory-dreaming",
      },
    );

    expect(runDreamingSweepPhasesMock).toHaveBeenCalledTimes(1);
    const sweepArgs = expectDefined(
      runDreamingSweepPhasesMock.mock.calls[0],
      "dreaming sweep call",
    )[0];
    expect(sweepArgs.agentId).toBe("researcher");
    expect(sweepArgs.workspaceDir).toBe(workspaceDir);
  });

  it("reports a degraded sweep when narrative cleanup fails", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-cleanup-degraded-");
    runDreamingSweepPhasesMock.mockResolvedValueOnce({
      degradedPhases: 1,
      pendingNarratives: 0,
    });
    const { api, harness, logger } = createDreamingTestContext({
      config: createDreamingConfig(
        {
          enabled: true,
          limit: 1,
          phases: { light: { enabled: false }, rem: { enabled: false } },
        },
        { agents: { defaults: { workspace: workspaceDir } } },
      ),
    });

    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, { config: api.config, getCron: () => harness.cron });
    const result = await getBeforeAgentReplyHandler(api.on)(
      { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
      { trigger: "cron", agentId: "main", workspaceDir },
    );

    expect(result).toEqual({
      handled: true,
      reason: "memory-core: short-term dreaming degraded",
    });
    expectLogContains(logger.warn, "failed=0, degraded=1, narrativesPending=0");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
