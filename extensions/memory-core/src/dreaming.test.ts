// Memory Core tests cover dreaming plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_MEMORY_DEEP_DREAMING_LIMIT,
  DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
  DEFAULT_MEMORY_DEEP_DREAMING_MAX_PRIOR_ENTRY_LOSS_FRACTION,
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT,
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE,
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES,
  DEFAULT_MEMORY_DEEP_DREAMING_RECENCY_HALF_LIFE_DAYS,
  DEFAULT_MEMORY_DREAMING_FREQUENCY,
  MANAGED_MEMORY_DREAMING_CRON_NAME,
  MANAGED_MEMORY_DREAMING_CRON_TAG,
  MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
} from "openclaw/plugin-sdk/memory-core-host-status";
import {
  enqueueSystemEvent,
  resetSystemEventsForTest,
} from "openclaw/plugin-sdk/system-event-runtime";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  registerShortTermPromotionDreaming,
  resolveShortTermPromotionDreamingConfig,
} from "./dreaming.js";
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
  DEFAULT_DREAMING_LIMIT: DEFAULT_MEMORY_DEEP_DREAMING_LIMIT,
  DEFAULT_DREAMING_MIN_SCORE: DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE,
  DEFAULT_DREAMING_MIN_RECALL_COUNT: DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT,
  DEFAULT_DREAMING_MIN_UNIQUE_QUERIES: DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES,
  DEFAULT_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS:
    DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
  DEFAULT_DREAMING_MAX_PRIOR_ENTRY_LOSS_FRACTION:
    DEFAULT_MEMORY_DEEP_DREAMING_MAX_PRIOR_ENTRY_LOSS_FRACTION,
  DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS: DEFAULT_MEMORY_DEEP_DREAMING_RECENCY_HALF_LIFE_DAYS,
  RUNTIME_CRON_RECONCILE_INTERVAL_MS: 60_000,
  STARTUP_CRON_RETRY_DELAY_MS: 5_000,
  STARTUP_CRON_RETRY_MAX_ATTEMPTS: 12,
};
const { createTempWorkspace } = createMemoryCoreTestHarness();

afterEach(() => {
  resetSystemEventsForTest();
});

function clearInternalHooks(): void {}

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
type DreamingPluginApi = Parameters<typeof registerShortTermPromotionDreaming>[0];
type DreamingPluginApiTestDouble = {
  config: OpenClawConfig;
  pluginConfig: Record<string, unknown>;
  logger: ReturnType<typeof createLogger>;
  runtime: unknown;
  on: ReturnType<typeof vi.fn>;
};

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createCronHarness(
  initialJobs: CronJobLike[] = [],
  opts?: {
    listThrowsForFirstCalls?: number;
    removeResult?: "boolean" | "unknown";
    removeThrowsForIds?: string[];
    staleJobs?: CronJobLike[];
  },
) {
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

function requireUpdateCall(
  harness: { updateCalls: Array<{ id: string; patch: CronPatch }> },
  index: number,
): { id: string; patch: CronPatch } {
  const call = harness.updateCalls[index];
  if (!call) {
    throw new Error(`expected cron update call ${index}`);
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

function getGatewayStartHandler(
  onMock: ReturnType<typeof vi.fn>,
): (
  event: { port: number },
  ctx: { config?: OpenClawConfig; workspaceDir?: string; getCron?: () => unknown },
) => Promise<unknown> {
  const call = onMock.mock.calls.find(([eventName]) => eventName === "gateway_start");
  if (!call) {
    throw new Error("gateway_start hook was not registered");
  }
  return call[1] as (
    event: { port: number },
    ctx: { config?: OpenClawConfig; workspaceDir?: string; getCron?: () => unknown },
  ) => Promise<unknown>;
}

function getGatewayStopHandler(
  onMock: ReturnType<typeof vi.fn>,
): (
  event: { reason?: string },
  ctx: { config?: OpenClawConfig; workspaceDir?: string; getCron?: () => unknown },
) => Promise<unknown> | void {
  const call = onMock.mock.calls.find(([eventName]) => eventName === "gateway_stop");
  if (!call) {
    throw new Error("gateway_stop hook was not registered");
  }
  return call[1] as (
    event: { reason?: string },
    ctx: { config?: OpenClawConfig; workspaceDir?: string; getCron?: () => unknown },
  ) => Promise<unknown> | void;
}

async function triggerGatewayStart(
  onMock: ReturnType<typeof vi.fn>,
  ctx: { config?: OpenClawConfig; workspaceDir?: string; getCron?: () => unknown },
): Promise<void> {
  await getGatewayStartHandler(onMock)({ port: 18789 }, ctx);
}

async function triggerGatewayStop(
  onMock: ReturnType<typeof vi.fn>,
  ctx: { config?: OpenClawConfig; workspaceDir?: string; getCron?: () => unknown } = {},
): Promise<void> {
  await getGatewayStopHandler(onMock)({ reason: "test" }, ctx);
}

function registerShortTermPromotionDreamingForTest(api: DreamingPluginApiTestDouble): void {
  registerShortTermPromotionDreaming(api as unknown as DreamingPluginApi);
}

describe("short-term dreaming config", () => {
  it("uses defaults and user timezone fallback", () => {
    const cfg = {
      agents: {
        defaults: {
          userTimezone: "America/Los_Angeles",
        },
      },
    } as OpenClawConfig;
    const resolved = resolveShortTermPromotionDreamingConfig({
      pluginConfig: {},
      cfg,
    });
    expect(resolved).toEqual({
      enabled: true,
      cron: constants.DEFAULT_DREAMING_CRON_EXPR,
      timezone: "America/Los_Angeles",
      limit: constants.DEFAULT_DREAMING_LIMIT,
      minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
      minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
      minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
      recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
      maxAgeDays: 30,
      maxPromotedSnippetTokens: constants.DEFAULT_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
      maxPriorEntryLossFraction: constants.DEFAULT_DREAMING_MAX_PRIOR_ENTRY_LOSS_FRACTION,
      verboseLogging: false,
      storage: {
        mode: "separate",
        separateReports: false,
      },
    });
  });

  it("reads explicit dreaming config values", () => {
    const resolved = resolveShortTermPromotionDreamingConfig({
      pluginConfig: {
        dreaming: {
          enabled: true,
          timezone: "UTC",
          verboseLogging: true,
          frequency: "5 1 * * *",
          model: "anthropic/claude-haiku-4-5",
          phases: {
            deep: {
              limit: 7,
              minScore: 0.4,
              minRecallCount: 2,
              minUniqueQueries: 3,
              recencyHalfLifeDays: 21,
              maxAgeDays: 30,
              maxPromotedSnippetTokens: 333,
            },
          },
        },
      },
    });
    expect(resolved).toEqual({
      enabled: true,
      cron: "5 1 * * *",
      timezone: "UTC",
      limit: 7,
      minScore: 0.4,
      minRecallCount: 2,
      minUniqueQueries: 3,
      recencyHalfLifeDays: 21,
      maxAgeDays: 30,
      maxPromotedSnippetTokens: 333,
      maxPriorEntryLossFraction: constants.DEFAULT_DREAMING_MAX_PRIOR_ENTRY_LOSS_FRACTION,
      verboseLogging: true,
      storage: {
        mode: "separate",
        separateReports: false,
      },
      execution: {
        model: "anthropic/claude-haiku-4-5",
      },
    });
  });

  it("accepts top-level frequency and numeric string thresholds", () => {
    const resolved = resolveShortTermPromotionDreamingConfig({
      pluginConfig: {
        dreaming: {
          enabled: true,
          frequency: "5 1 * * *",
          phases: {
            deep: {
              limit: "4",
              minScore: "0.6",
              minRecallCount: "2",
              minUniqueQueries: "3",
              recencyHalfLifeDays: "9",
              maxAgeDays: "45",
              maxPromotedSnippetTokens: "222",
            },
          },
        },
      },
    });
    expect(resolved).toEqual({
      enabled: true,
      cron: "5 1 * * *",
      limit: 4,
      minScore: 0.6,
      minRecallCount: 2,
      minUniqueQueries: 3,
      recencyHalfLifeDays: 9,
      maxAgeDays: 45,
      maxPromotedSnippetTokens: 222,
      maxPriorEntryLossFraction: constants.DEFAULT_DREAMING_MAX_PRIOR_ENTRY_LOSS_FRACTION,
      verboseLogging: false,
      storage: {
        mode: "separate",
        separateReports: false,
      },
    });
  });

  it("treats blank numeric strings as unset and keeps preset defaults", () => {
    const resolved = resolveShortTermPromotionDreamingConfig({
      pluginConfig: {
        dreaming: {
          enabled: true,
          phases: {
            deep: {
              limit: " ",
              minScore: "",
              minRecallCount: "  ",
              minUniqueQueries: "",
              recencyHalfLifeDays: "",
              maxAgeDays: " ",
              maxPromotedSnippetTokens: "",
            },
          },
        },
      },
    });
    expect(resolved).toEqual({
      enabled: true,
      cron: constants.DEFAULT_DREAMING_CRON_EXPR,
      limit: constants.DEFAULT_DREAMING_LIMIT,
      minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
      minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
      minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
      recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
      maxAgeDays: 30,
      maxPromotedSnippetTokens: constants.DEFAULT_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
      maxPriorEntryLossFraction: constants.DEFAULT_DREAMING_MAX_PRIOR_ENTRY_LOSS_FRACTION,
      verboseLogging: false,
      storage: {
        mode: "separate",
        separateReports: false,
      },
    });
  });

  it("accepts limit=0 as an explicit no-op promotion cap", () => {
    const resolved = resolveShortTermPromotionDreamingConfig({
      pluginConfig: {
        dreaming: {
          enabled: true,
          phases: {
            deep: {
              limit: 0,
            },
          },
        },
      },
    });
    expect(resolved.limit).toBe(0);
  });

  it("accepts verboseLogging as a boolean or boolean string", () => {
    const enabled = resolveShortTermPromotionDreamingConfig({
      pluginConfig: {
        dreaming: {
          verboseLogging: true,
        },
      },
    });
    const disabled = resolveShortTermPromotionDreamingConfig({
      pluginConfig: {
        dreaming: {
          verboseLogging: "false",
        },
      },
    });

    expect(enabled.verboseLogging).toBe(true);
    expect(disabled.verboseLogging).toBe(false);
  });

  it("falls back to defaults when thresholds are negative", () => {
    const resolved = resolveShortTermPromotionDreamingConfig({
      pluginConfig: {
        dreaming: {
          enabled: true,
          phases: {
            deep: {
              minScore: -0.2,
              minRecallCount: -2,
              minUniqueQueries: -4,
              recencyHalfLifeDays: -10,
              maxAgeDays: -5,
              maxPromotedSnippetTokens: -10,
            },
          },
        },
      },
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.minScore).toBe(constants.DEFAULT_DREAMING_MIN_SCORE);
    expect(resolved.minRecallCount).toBe(constants.DEFAULT_DREAMING_MIN_RECALL_COUNT);
    expect(resolved.minUniqueQueries).toBe(constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES);
    expect(resolved.recencyHalfLifeDays).toBe(constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS);
    expect(resolved.maxAgeDays).toBe(30);
    expect(resolved.maxPromotedSnippetTokens).toBe(
      constants.DEFAULT_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
    );
  });

  it("keeps deep sleep disabled when the phase is off", () => {
    const resolved = resolveShortTermPromotionDreamingConfig({
      pluginConfig: {
        dreaming: {
          phases: {
            deep: {
              enabled: false,
            },
          },
        },
      },
    });
    expect(resolved.enabled).toBe(false);
  });
});

describe("gateway startup reconciliation", () => {
  let liveConfigRunPayloadCase: {
    result: unknown;
    runtimeConfigCalled: boolean;
    warnCalls: unknown[][];
  };

  beforeAll(async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const workspaceDir = await createTempWorkspace("memory-dreaming-live-config-workspace-");
    const runtimeCurrentConfig = vi.fn(
      () =>
        ({
          agents: {
            list: [{ id: "main", default: true, workspace: workspaceDir }],
          },
          plugins: {
            entries: {
              "memory-core": {
                config: {
                  dreaming: {
                    enabled: true,
                    frequency: "15 4 * * *",
                    timezone: "UTC",
                    limit: 0,
                  },
                },
              },
            },
          },
        }) as OpenClawConfig,
    );
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  frequency: "15 4 * * *",
                  timezone: "UTC",
                  limit: 5,
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      pluginConfig: {},
      logger,
      runtime: {
        config: {
          current: runtimeCurrentConfig,
        },
      },
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => harness.cron,
      });

      const sessionKey = "agent:main:main";
      enqueueSystemEvent(constants.DREAMING_SYSTEM_EVENT_TEXT, {
        sessionKey,
        contextKey: "cron:memory-dreaming",
      });

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      liveConfigRunPayloadCase = {
        result: await beforeAgentReply(
          { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
          { trigger: "heartbeat", sessionKey },
        ),
        runtimeConfigCalled: runtimeCurrentConfig.mock.calls.length > 0,
        warnCalls: [...logger.warn.mock.calls],
      };
    } finally {
      await triggerGatewayStop(onMock).catch(() => undefined);
      clearInternalHooks();
    }
  });

  it("uses the startup cfg when reconciling the managed dreaming cron job", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: { plugins: { entries: {} } },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, {
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
    } finally {
      clearInternalHooks();
    }
  });

  it("recovers on the runtime interval after startup cron reconciliation fails", async () => {
    vi.useFakeTimers();
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness([], { listThrowsForFirstCalls: 1 });
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
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
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, {
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
      await triggerGatewayStop(onMock).catch(() => undefined);
      vi.useRealTimers();
      clearInternalHooks();
    }
  });

  it("does not arm runtime recovery after gateway_stop wins the startup race", async () => {
    vi.useFakeTimers();
    clearInternalHooks();
    const logger = createLogger();
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
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
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
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      const startup = triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => cron,
      });

      await triggerGatewayStop(onMock);
      rejectStartupList(new Error("startup list failed"));
      await startup;
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);

      expect(listCalls).toBe(1);
      expect(addCalls).toHaveLength(0);
      expectLogContains(logger.error, "dreaming startup reconciliation failed");
    } finally {
      await triggerGatewayStop(onMock).catch(() => undefined);
      vi.useRealTimers();
      clearInternalHooks();
    }
  });

  it("reconciles disabled->enabled config changes during runtime", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: false,
                  frequency: "0 2 * * *",
                  timezone: "UTC",
                },
              },
            },
          },
        },
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => harness.cron,
      });

      expect(harness.addCalls).toHaveLength(0);

      api.config = {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  frequency: "30 6 * * *",
                  timezone: "America/New_York",
                },
              },
            },
          },
        },
      } as OpenClawConfig;

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      await beforeAgentReply(
        { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
        { trigger: "heartbeat", workspaceDir: "." },
      );

      expect(harness.addCalls).toHaveLength(1);
      expectCronSchedule(requireAddCall(harness, 0).schedule, "30 6 * * *", "America/New_York");
    } finally {
      clearInternalHooks();
    }
  });

  it("reconciles disabled->enabled config changes without waiting for another agent turn", async () => {
    vi.useFakeTimers();
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: false,
                  frequency: "0 2 * * *",
                  timezone: "UTC",
                },
              },
            },
          },
        },
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => harness.cron,
      });

      expect(harness.addCalls).toHaveLength(0);

      api.config = {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  frequency: "30 6 * * *",
                  timezone: "America/New_York",
                },
              },
            },
          },
        },
      } as OpenClawConfig;

      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);

      expect(harness.addCalls).toHaveLength(1);
      expectCronSchedule(requireAddCall(harness, 0).schedule, "30 6 * * *", "America/New_York");
    } finally {
      await triggerGatewayStop(onMock).catch(() => undefined);
      vi.useRealTimers();
      clearInternalHooks();
    }
  });

  it("reconciles cadence/timezone updates against the active cron service after startup", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const startupHarness = createCronHarness();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  frequency: "0 1 * * *",
                  timezone: "UTC",
                },
              },
            },
          },
        },
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      const cronRef = { current: startupHarness.cron };
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => cronRef.current,
      });

      expect(startupHarness.addCalls).toHaveLength(1);
      const managed = startupHarness.jobs.find((job) =>
        job.description?.includes("[managed-by=memory-core.short-term-promotion]"),
      );
      if (!managed) {
        throw new Error("expected managed short-term promotion dreaming job");
      }
      expect(managed.description).toContain("[managed-by=memory-core.short-term-promotion]");

      const reloadedHarness = createCronHarness([
        {
          ...managed,
          schedule: managed.schedule ? { ...managed.schedule } : undefined,
          payload: managed.payload ? { ...managed.payload } : undefined,
        },
      ]);
      cronRef.current = reloadedHarness.cron;
      api.config = {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  frequency: "45 8 * * *",
                  timezone: "America/Los_Angeles",
                },
              },
            },
          },
        },
      } as OpenClawConfig;

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      await beforeAgentReply(
        { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
        { trigger: "heartbeat", workspaceDir: "." },
      );

      expect(startupHarness.updateCalls).toHaveLength(0);
      expect(reloadedHarness.updateCalls).toHaveLength(1);
      expectCronSchedule(
        requireUpdateCall(reloadedHarness, 0).patch.schedule,
        "45 8 * * *",
        "America/Los_Angeles",
      );
    } finally {
      clearInternalHooks();
    }
  });

  it("updates a seeded old-schedule managed job in place by its stable name", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness([
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
    ]);
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: { dreaming: { enabled: true, frequency: "*/3 * * * *" } },
            },
          },
        },
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, { config: api.config, getCron: () => harness.cron });

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
      await triggerGatewayStop(onMock).catch(() => undefined);
      clearInternalHooks();
    }
  });

  it("removes seeded stale managed duplicates before reconciling the survivor", async () => {
    clearInternalHooks();
    const logger = createLogger();
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
    const harness = createCronHarness([
      seeded("job-oldest", 10, "0 3 * * *"),
      seeded("job-duplicate", 20, "*/5 * * * *"),
    ]);
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: { dreaming: { enabled: true, frequency: "*/3 * * * *" } },
            },
          },
        },
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, { config: api.config, getCron: () => harness.cron });

      expect(harness.addCalls).toHaveLength(1);
      expect(harness.removeCalls).toEqual(["job-oldest", "job-duplicate"]);
      expect(harness.updateCalls).toHaveLength(0);
      expectCronSchedule(requireAddCall(harness, 0).schedule, "*/3 * * * *");
      expect(harness.jobs).toHaveLength(1);
      expect(harness.jobs[0]?.declarationKey).toBe("memory-core:memory-dreaming-promotion");
    } finally {
      await triggerGatewayStop(onMock).catch(() => undefined);
      clearInternalHooks();
    }
  });

  it("adopts the exact legacy row from an obsolete store beside the declaration job", async () => {
    clearInternalHooks();
    const logger = createLogger();
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
    const harness = createCronHarness([declaredRow], { staleJobs: [legacyRow] });
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: { dreaming: { enabled: true, frequency: "*/3 * * * *" } },
            },
          },
        },
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, { config: api.config, getCron: () => harness.cron });

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
      await triggerGatewayStop(onMock).catch(() => undefined);
      clearInternalHooks();
    }
  });

  it("recreates the managed cron job when it is removed after startup", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  frequency: "0 2 * * *",
                  timezone: "UTC",
                },
              },
            },
          },
        },
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, {
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

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      await beforeAgentReply(
        { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
        { trigger: "heartbeat", workspaceDir: "." },
      );

      expect(harness.addCalls).toHaveLength(2);
      expectCronSchedule(requireAddCall(harness, 1).schedule, "0 2 * * *", "UTC");
    } finally {
      clearInternalHooks();
    }
  });

  it("does not reconcile managed cron on non-heartbeat runtime replies", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  frequency: "0 2 * * *",
                  timezone: "UTC",
                },
              },
            },
          },
        },
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => harness.cron,
      });

      expect(harness.listCalls).toBe(1);

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      await beforeAgentReply({ cleanedBody: "hello" }, { trigger: "user", workspaceDir: "." });
      await beforeAgentReply(
        { cleanedBody: "hello again" },
        { trigger: "user", workspaceDir: "." },
      );

      expect(harness.listCalls).toBe(1);
    } finally {
      clearInternalHooks();
    }
  });

  it("does not reconcile managed cron on every repeated runtime heartbeat", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const now = Date.parse("2026-04-10T12:00:00Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  frequency: "0 2 * * *",
                  timezone: "UTC",
                },
              },
            },
          },
        },
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => harness.cron,
      });

      expect(harness.listCalls).toBe(1);

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      await beforeAgentReply(
        { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
        { trigger: "heartbeat", workspaceDir: "." },
      );
      await beforeAgentReply(
        { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
        { trigger: "heartbeat", workspaceDir: "." },
      );

      expect(harness.listCalls).toBe(2);
    } finally {
      nowSpy.mockRestore();
      clearInternalHooks();
    }
  });

  it("only triggers managed dreaming when the queued cron event is still pending", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: false,
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => harness.cron,
      });

      const sessionKey = "agent:main:main";
      enqueueSystemEvent(constants.DREAMING_SYSTEM_EVENT_TEXT, {
        sessionKey,
        contextKey: "cron:memory-dreaming",
      });

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
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
    } finally {
      clearInternalHooks();
    }
  });

  it("resolves queued managed dreaming cron events from the base session for isolated heartbeats", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: false,
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => harness.cron,
      });

      enqueueSystemEvent(constants.DREAMING_SYSTEM_EVENT_TEXT, {
        sessionKey: "agent:main:main",
        contextKey: "cron:memory-dreaming",
      });

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      const result = await beforeAgentReply(
        { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
        { trigger: "heartbeat", workspaceDir: ".", sessionKey: "agent:main:main:heartbeat" },
      );

      expect(result).toEqual({
        handled: true,
        reason: "memory-core: short-term dreaming disabled",
      });
    } finally {
      clearInternalHooks();
    }
  });

  it("does not emit the cron-unavailable warning on gateway_start when cron is missing (regression #69939)", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const api: DreamingPluginApiTestDouble = {
      config: { plugins: { entries: {} } },
      pluginConfig: {},
      logger,
      runtime: {},
      on: vi.fn(),
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(api.on, {
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
        getCron: () => undefined,
      });

      expectLogNotContains(logger.warn, "cron service unavailable");
      // The startup-path log should be demoted to debug instead.
      expectLogContains(logger.debug, "cron service not yet available at gateway_start");
    } finally {
      clearInternalHooks();
    }
  });

  it("keeps ordinary heartbeat reconciliation quiet when no gateway cron context is available", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
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
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      await beforeAgentReply(
        { cleanedBody: "" },
        { trigger: "heartbeat", workspaceDir: ".", sessionKey: "agent:main:main:heartbeat" },
      );

      expectLogNotContains(logger.warn, "cron service unavailable");
    } finally {
      clearInternalHooks();
    }
  });

  it("still warns on gateway runtime reconciliation when cron remains unavailable", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
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
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => undefined,
      });
      expect(logger.warn).not.toHaveBeenCalled();

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      await beforeAgentReply(
        { cleanedBody: "" },
        { trigger: "heartbeat", workspaceDir: ".", sessionKey: "agent:main:main:heartbeat" },
      );

      expectLogContains(logger.warn, "cron service unavailable");
    } finally {
      await triggerGatewayStop(onMock);
      clearInternalHooks();
    }
  });

  it("still warns on managed runtime reconciliation when cron remains unavailable (preserves #69939 genuine-failure signal)", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
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
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      // Startup without cron — must stay silent on warn.
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => undefined,
      });
      expect(logger.warn).not.toHaveBeenCalled();

      // Now a managed runtime reconciliation happens and cron is still missing
      // (e.g. the cron service genuinely failed to initialize). The warning must fire.
      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      await beforeAgentReply(
        { cleanedBody: "" },
        { trigger: "cron", workspaceDir: ".", sessionKey: "agent:main:cron:job-managed" },
      );

      expectLogContains(logger.warn, "cron service unavailable");
    } finally {
      await triggerGatewayStop(onMock);
      clearInternalHooks();
    }
  });

  it("retries startup cron reconciliation until cron is available without a heartbeat (regression #72841)", async () => {
    vi.useFakeTimers();
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
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
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      let cronAvailable = false;
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => (cronAvailable ? harness.cron : undefined),
      });

      expect(harness.addCalls).toHaveLength(0);
      expectLogContains(logger.debug, "cron service not yet available at gateway_start");

      await vi.advanceTimersByTimeAsync(constants.STARTUP_CRON_RETRY_DELAY_MS);
      expect(harness.addCalls).toHaveLength(0);
      expectLogNotContains(logger.warn, "cron service unavailable");
      expectLogContains(logger.debug, "cron service not yet available at gateway_start");

      cronAvailable = true;
      await vi.advanceTimersByTimeAsync(constants.STARTUP_CRON_RETRY_DELAY_MS);

      expect(harness.addCalls).toHaveLength(1);
      const addCall = requireAddCall(harness, 0);
      expect(addCall.name).toBe("Memory Dreaming Promotion");
      expectCronSchedule(addCall.schedule, "15 4 * * *", "UTC");
      expect(addCall.sessionTarget).toBe("isolated");
      const payload = requireAgentTurnPayload(addCall.payload);
      expect(payload.message).toBe(constants.DREAMING_SYSTEM_EVENT_TEXT);
      expect(payload.lightContext).toBe(true);
    } finally {
      vi.useRealTimers();
      clearInternalHooks();
    }
  });

  it("keeps startup cron retry warnings quiet until the retry window is exhausted", async () => {
    vi.useFakeTimers();
    clearInternalHooks();
    const logger = createLogger();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
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
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => undefined,
      });

      expectLogContains(logger.debug, "cron service not yet available at gateway_start");

      await vi.advanceTimersByTimeAsync(
        constants.STARTUP_CRON_RETRY_DELAY_MS * (constants.STARTUP_CRON_RETRY_MAX_ATTEMPTS - 1),
      );
      expectLogNotContains(logger.warn, "cron service unavailable");

      await vi.advanceTimersByTimeAsync(constants.STARTUP_CRON_RETRY_DELAY_MS);

      expectLogContains(logger.warn, "cron service unavailable");
      expect(logger.warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      await triggerGatewayStop(onMock);
      clearInternalHooks();
    }
  });

  it("retries disabled startup cleanup until cron is available", async () => {
    vi.useFakeTimers();
    clearInternalHooks();
    const logger = createLogger();
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
    const harness = createCronHarness([managedJob]);
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: false,
                  frequency: "15 4 * * *",
                  timezone: "UTC",
                },
              },
            },
          },
        },
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      let cronAvailable = false;
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => (cronAvailable ? harness.cron : undefined),
      });

      await vi.advanceTimersByTimeAsync(constants.STARTUP_CRON_RETRY_DELAY_MS);
      expect(harness.removeCalls).toHaveLength(0);

      cronAvailable = true;
      await vi.advanceTimersByTimeAsync(constants.STARTUP_CRON_RETRY_DELAY_MS);

      expect(harness.removeCalls).toEqual(["job-managed"]);
      expect(harness.jobs).toHaveLength(0);
      expect(harness.addCalls).toHaveLength(0);
      expectLogContains(logger.info, "removed 1 managed dreaming cron job");
    } finally {
      vi.useRealTimers();
      clearInternalHooks();
    }
  });

  it("does not recreate startup cron from stale enabled config after runtime config disables dreaming", async () => {
    vi.useFakeTimers();
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness([], { listThrowsForFirstCalls: 1 });
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
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
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      let cronAvailable = false;
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => (cronAvailable ? harness.cron : undefined),
      });

      api.config = {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: false,
                  frequency: "15 4 * * *",
                  timezone: "UTC",
                },
              },
            },
          },
        },
      } as OpenClawConfig;
      cronAvailable = true;

      await vi.advanceTimersByTimeAsync(constants.STARTUP_CRON_RETRY_DELAY_MS);
      await vi.advanceTimersByTimeAsync(constants.STARTUP_CRON_RETRY_DELAY_MS);

      expectLogContains(logger.error, "deferred dreaming cron retry failed");
      expect(harness.listCalls).toBe(1);
      expect(harness.addCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      clearInternalHooks();
    }
  });

  it("uses default-on cadence instead of stale startup config when live memory-core config is removed", async () => {
    vi.useFakeTimers();
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const runtimeCurrentConfig = vi.fn(
      () =>
        ({
          plugins: {
            entries: {},
          },
        }) as OpenClawConfig,
    );
    const api: DreamingPluginApiTestDouble = {
      config: {
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
      pluginConfig: {},
      logger,
      runtime: {
        config: {
          current: runtimeCurrentConfig,
        },
      },
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      let cronAvailable = false;
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => (cronAvailable ? harness.cron : undefined),
      });

      cronAvailable = true;
      await vi.advanceTimersByTimeAsync(constants.STARTUP_CRON_RETRY_DELAY_MS);

      expect(runtimeCurrentConfig).toHaveBeenCalled();
      expect(harness.addCalls).toHaveLength(1);
      expect(harness.addCalls[0]?.schedule.expr).toBe(constants.DEFAULT_DREAMING_CRON_EXPR);
      expectLogNotContains(logger.warn, "cron service unavailable");
    } finally {
      vi.useRealTimers();
      await triggerGatewayStop(onMock).catch(() => undefined);
      clearInternalHooks();
    }
  });

  it("clears pending startup cron retry on gateway stop", async () => {
    vi.useFakeTimers();
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
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
      },
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      let cronAvailable = false;
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => (cronAvailable ? harness.cron : undefined),
      });

      await triggerGatewayStop(onMock);
      cronAvailable = true;
      await vi.advanceTimersByTimeAsync(
        constants.STARTUP_CRON_RETRY_DELAY_MS * constants.STARTUP_CRON_RETRY_MAX_ATTEMPTS,
      );

      expect(harness.addCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      clearInternalHooks();
    }
  });

  it("uses live runtime config for heartbeat dreaming reconciliation", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const runtimeCurrentConfig = vi.fn(
      () =>
        ({
          plugins: {
            entries: {
              "memory-core": {
                config: {
                  dreaming: {
                    enabled: false,
                  },
                },
              },
            },
          },
        }) as OpenClawConfig,
    );
    const api: DreamingPluginApiTestDouble = {
      config: {
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
      pluginConfig: {},
      logger,
      runtime: {
        config: {
          current: runtimeCurrentConfig,
        },
      },
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => harness.cron,
      });

      const sessionKey = "agent:main:main";
      enqueueSystemEvent(constants.DREAMING_SYSTEM_EVENT_TEXT, {
        sessionKey,
        contextKey: "cron:memory-dreaming",
      });

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      const result = await beforeAgentReply(
        { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
        { trigger: "heartbeat", workspaceDir: ".", sessionKey },
      );

      expect(runtimeCurrentConfig).toHaveBeenCalled();
      expect(result).toEqual({
        handled: true,
        reason: "memory-core: short-term dreaming disabled",
      });
    } finally {
      clearInternalHooks();
    }
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
    clearInternalHooks();
    const workspaceDir = await createTempWorkspace("memory-dreaming-default-on-live-config-");
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const runtimeCurrentConfig = vi.fn(
      () =>
        ({
          agents: {
            defaults: { workspace: workspaceDir },
            list: [{ id: "main", default: true, workspace: workspaceDir }],
          },
        }) as OpenClawConfig,
    );
    const api: DreamingPluginApiTestDouble = {
      config: {
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
      pluginConfig: {},
      logger,
      runtime: {
        config: {
          current: runtimeCurrentConfig,
        },
      },
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => harness.cron,
      });

      const sessionKey = "agent:main:main";
      enqueueSystemEvent(constants.DREAMING_SYSTEM_EVENT_TEXT, {
        sessionKey,
        contextKey: "cron:memory-dreaming",
      });

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      const result = await beforeAgentReply(
        { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
        { trigger: "heartbeat", workspaceDir, sessionKey },
      );

      expect(runtimeCurrentConfig).toHaveBeenCalled();
      expect(result).toEqual({
        handled: true,
        reason: "memory-core: short-term dreaming processed",
      });
    } finally {
      clearInternalHooks();
    }
  });

  it("handles managed dreaming cron triggers without a queued heartbeat event", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: false,
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => harness.cron,
      });

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      const result = await beforeAgentReply(
        { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
        { trigger: "cron", workspaceDir: ".", sessionKey: "cron:memory-dreaming" },
      );

      expect(result).toEqual({
        handled: true,
        reason: "memory-core: short-term dreaming disabled",
      });
    } finally {
      clearInternalHooks();
    }
  });

  // Regression: the sweep dropped the agent id entirely, so narrative subagent sessions used
  // unscoped keys that no per-agent SQLite store could resolve and every phase failed.
  it("sweeps each workspace as its owning agent rather than the roster default", async () => {
    clearInternalHooks();
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-owner-");
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    runDreamingSweepPhasesMock.mockClear();
    const api: DreamingPluginApiTestDouble = {
      config: {
        agents: {
          defaults: { workspace: workspaceDir },
        },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  limit: 5,
                  phases: {
                    light: { enabled: false },
                    rem: { enabled: false },
                  },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, {
        config: api.config,
        getCron: () => harness.cron,
      });

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
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
    } finally {
      clearInternalHooks();
    }
  });

  it("reports a degraded sweep when narrative cleanup fails", async () => {
    clearInternalHooks();
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-cleanup-degraded-");
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    runDreamingSweepPhasesMock.mockResolvedValueOnce({
      degradedPhases: 1,
      pendingNarratives: 0,
    });
    const api: DreamingPluginApiTestDouble = {
      config: {
        agents: { defaults: { workspace: workspaceDir } },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  limit: 1,
                  phases: { light: { enabled: false }, rem: { enabled: false } },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      pluginConfig: {},
      logger,
      runtime: {},
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerGatewayStart(onMock, { config: api.config, getCron: () => harness.cron });
      const result = await getBeforeAgentReplyHandler(onMock)(
        { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
        { trigger: "cron", agentId: "main", workspaceDir },
      );

      expect(result).toEqual({
        handled: true,
        reason: "memory-core: short-term dreaming degraded",
      });
      expectLogContains(logger.warn, "failed=0, degraded=1, narrativesPending=0");
    } finally {
      clearInternalHooks();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
