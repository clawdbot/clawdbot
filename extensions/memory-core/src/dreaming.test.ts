// Memory Core tests cover dreaming plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_MEMORY_DEEP_DREAMING_LIMIT,
  DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
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
  },
) {
  const jobs: CronJobLike[] = [...initialJobs];
  let listCalls = 0;
  const addCalls: CronAddInput[] = [];
  const updateCalls: Array<{ id: string; patch: CronPatch }> = [];
  const removeCalls: string[] = [];

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
      addCalls.push(input);
      jobs.push({
        id: `job-${jobs.length + 1}`,
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
  };

  return {
    cron,
    jobs,
    addCalls,
    updateCalls,
    removeCalls,
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
  ctx: { trigger?: string; workspaceDir?: string; sessionKey?: string },
) => Promise<unknown> {
  const call = onMock.mock.calls.find(([eventName]) => eventName === "before_agent_reply");
  if (!call) {
    throw new Error("before_agent_reply hook was not registered");
  }
  return call[1] as (
    event: { cleanedBody: string },
    ctx: { trigger?: string; workspaceDir?: string; sessionKey?: string },
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
      enabled: false,
      cron: constants.DEFAULT_DREAMING_CRON_EXPR,
      timezone: "America/Los_Angeles",
      limit: constants.DEFAULT_DREAMING_LIMIT,
      minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
      minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
      minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
      recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
      maxAgeDays: 30,
      maxPromotedSnippetTokens: constants.DEFAULT_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
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
      expectCronSchedule(addCall.schedule, "15 4 * * *", "UTC");
      expect(addCall.delivery?.mode).toBe("none");
      expectLogContains(logger.info, "created managed dreaming cron job");
    } finally {
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
      name: constants.MANAGED_DREAMING_CRON_NAME,
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

  it("does not recreate startup cron from stale enabled config after live memory-core config is removed", async () => {
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
      expect(harness.addCalls).toHaveLength(0);
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

  it("does not fall back to startup plugin config when live memory-core config is removed", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const runtimeCurrentConfig = vi.fn(
      () =>
        ({
          agents: {
            list: [{ id: "main", default: true }],
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
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
