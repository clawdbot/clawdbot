import fs from "node:fs/promises";
import path from "node:path";
import { enqueueSystemEvent, resetSystemEventsForTest } from "openclaw/plugin-sdk/infra-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearInternalHooks,
  createInternalHookEvent,
  registerInternalHook,
  triggerInternalHook,
} from "../../../src/hooks/internal-hooks.js";
import {
  __testing,
  reconcileShortTermDreamingCronJob,
  registerShortTermPromotionDreaming,
  resolveShortTermPromotionDreamingConfig,
  runShortTermDreamingPromotionIfTriggered,
} from "./dreaming.js";
import { recordShortTermRecalls } from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const constants = __testing.constants;
const { createTempWorkspace } = createMemoryCoreTestHarness();

afterEach(() => {
  resetSystemEventsForTest();
});

type CronParam = NonNullable<Parameters<typeof reconcileShortTermDreamingCronJob>[0]["cron"]>;
type CronJobLike = Awaited<ReturnType<CronParam["list"]>>[number];
type CronAddInput = Parameters<CronParam["add"]>[0];
type CronPatch = Parameters<CronParam["update"]>[1];
type DreamingPluginApi = Parameters<typeof registerShortTermPromotionDreaming>[0];
type DreamingPluginApiTestDouble = {
  config: OpenClawConfig;
  pluginConfig: Record<string, unknown>;
  logger: ReturnType<typeof createLogger>;
  runtime: unknown;
  registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => void;
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

async function writeDailyMemoryNote(
  workspaceDir: string,
  date: string,
  lines: string[],
): Promise<void> {
  const notePath = path.join(workspaceDir, "memory", `${date}.md`);
  await fs.mkdir(path.dirname(notePath), { recursive: true });
  await fs.writeFile(notePath, `${lines.join("\n")}\n`, "utf-8");
}

function createCronHarness(
  initialJobs: CronJobLike[] = [],
  opts?: { removeResult?: "boolean" | "unknown"; removeThrowsForIds?: string[] },
) {
  const jobs: CronJobLike[] = [...initialJobs];
  let listCalls = 0;
  const addCalls: CronAddInput[] = [];
  const updateCalls: Array<{ id: string; patch: CronPatch }> = [];
  const removeCalls: string[] = [];

  const cron: CronParam = {
    async list() {
      listCalls += 1;
      return jobs.map((job) => ({
        ...job,
        ...(job.schedule ? { schedule: { ...job.schedule } } : {}),
        ...(job.payload ? { payload: { ...job.payload } } : {}),
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
      const current = jobs[index];
      jobs[index] = {
        ...current,
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.description ? { description: patch.description } : {}),
        ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
        ...(patch.schedule ? { schedule: { ...patch.schedule } } : {}),
        ...(patch.sessionTarget ? { sessionTarget: patch.sessionTarget } : {}),
        ...(patch.wakeMode ? { wakeMode: patch.wakeMode } : {}),
        ...(patch.payload ? { payload: { ...patch.payload } } : {}),
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
          phases: {
            deep: {
              limit: 7,
              minScore: 0.4,
              minRecallCount: 2,
              minUniqueQueries: 3,
              recencyHalfLifeDays: 21,
              maxAgeDays: 30,
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
      verboseLogging: true,
      storage: {
        mode: "separate",
        separateReports: false,
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
            },
          },
        },
      },
    });
    expect(resolved).toMatchObject({
      enabled: true,
      minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
      minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
      minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
      recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
    });
    expect(resolved.maxAgeDays).toBe(30);
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

describe("short-term dreaming startup event parsing", () => {
  it("resolves cron service from gateway startup event deps", () => {
    const harness = createCronHarness();
    const resolved = __testing.resolveCronServiceFromStartupEvent({
      type: "gateway",
      action: "startup",
      context: {
        deps: {
          cron: harness.cron,
        },
      },
    });
    expect(resolved).toBe(harness.cron);
  });
});

describe("short-term dreaming cron reconciliation", () => {
  it("creates a managed cron job when enabled", async () => {
    const harness = createCronHarness();
    const logger = createLogger();
    const result = await reconcileShortTermDreamingCronJob({
      cron: harness.cron,
      config: {
        enabled: true,
        cron: "0 1 * * *",
        timezone: "UTC",
        limit: 8,
        minScore: 0.5,
        minRecallCount: 4,
        minUniqueQueries: 5,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
    });

    expect(result.status).toBe("added");
    expect(harness.addCalls).toHaveLength(1);
    expect(harness.addCalls[0]).toMatchObject({
      name: constants.MANAGED_DREAMING_CRON_NAME,
      sessionTarget: "main",
      wakeMode: "now",
      payload: {
        kind: "systemEvent",
        text: constants.DREAMING_SYSTEM_EVENT_TEXT,
      },
      schedule: {
        kind: "cron",
        expr: "0 1 * * *",
        tz: "UTC",
      },
    });
  });

  it("updates drifted managed jobs and prunes duplicates", async () => {
    const desiredConfig = {
      enabled: true,
      cron: "0 3 * * *",
      timezone: "America/Los_Angeles",
      limit: 10,
      minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
      minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
      minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
      recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
      verboseLogging: false,
    } as const;
    const desired = __testing.buildManagedDreamingCronJob(desiredConfig);
    const stalePrimary: CronJobLike = {
      id: "job-primary",
      name: desired.name,
      description: desired.description,
      enabled: false,
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "systemEvent",
        text: "stale-text",
      },
      createdAtMs: 1,
    };
    const duplicate: CronJobLike = {
      ...desired,
      id: "job-duplicate",
      createdAtMs: 2,
    };
    const unmanaged: CronJobLike = {
      id: "job-unmanaged",
      name: "other",
      description: "not managed",
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hello" },
      createdAtMs: 3,
    };
    const harness = createCronHarness([stalePrimary, duplicate, unmanaged]);
    const logger = createLogger();

    const result = await reconcileShortTermDreamingCronJob({
      cron: harness.cron,
      config: desiredConfig,
      logger,
    });

    expect(result.status).toBe("updated");
    expect(result.removed).toBe(1);
    expect(harness.removeCalls).toEqual(["job-duplicate"]);
    expect(harness.updateCalls).toHaveLength(1);
    expect(harness.updateCalls[0]).toMatchObject({
      id: "job-primary",
      patch: {
        enabled: true,
        wakeMode: "now",
        schedule: desired.schedule,
        payload: desired.payload,
      },
    });
  });

  it("removes managed dreaming jobs when disabled", async () => {
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
    const unmanagedJob: CronJobLike = {
      id: "job-other",
      name: "Daily report",
      description: "other",
      enabled: true,
      schedule: { kind: "cron", expr: "0 7 * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "report" },
      createdAtMs: 11,
    };
    const harness = createCronHarness([managedJob, unmanagedJob]);
    const logger = createLogger();

    const result = await reconcileShortTermDreamingCronJob({
      cron: harness.cron,
      config: {
        enabled: false,
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        limit: constants.DEFAULT_DREAMING_LIMIT,
        minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
        minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
        minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
    });

    expect(result).toEqual({ status: "disabled", removed: 1 });
    expect(harness.removeCalls).toEqual(["job-managed"]);
    expect(harness.jobs.map((entry) => entry.id)).toEqual(["job-other"]);
  });

  it("migrates legacy light/rem dreaming cron jobs during reconciliation", async () => {
    const deepManagedJob: CronJobLike = {
      id: "job-deep",
      name: constants.MANAGED_DREAMING_CRON_NAME,
      description: `${constants.MANAGED_DREAMING_CRON_TAG} test`,
      enabled: true,
      schedule: { kind: "cron", expr: "0 3 * * *" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: constants.DREAMING_SYSTEM_EVENT_TEXT },
      createdAtMs: 10,
    };
    const legacyLightJob: CronJobLike = {
      id: "job-light",
      name: "Memory Light Dreaming",
      description: "[managed-by=memory-core.dreaming.light] legacy",
      enabled: true,
      schedule: { kind: "cron", expr: "0 */6 * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "__openclaw_memory_core_light_sleep__" },
      createdAtMs: 8,
    };
    const legacyRemJob: CronJobLike = {
      id: "job-rem",
      name: "Memory REM Dreaming",
      description: "[managed-by=memory-core.dreaming.rem] legacy",
      enabled: true,
      schedule: { kind: "cron", expr: "0 5 * * 0" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "__openclaw_memory_core_rem_sleep__" },
      createdAtMs: 9,
    };
    const harness = createCronHarness([legacyLightJob, legacyRemJob, deepManagedJob]);
    const logger = createLogger();

    const result = await reconcileShortTermDreamingCronJob({
      cron: harness.cron,
      config: {
        enabled: true,
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        limit: constants.DEFAULT_DREAMING_LIMIT,
        minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
        minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
        minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
    });

    expect(result.status).toBe("updated");
    expect(result.removed).toBe(2);
    expect(harness.removeCalls).toEqual(["job-light", "job-rem"]);
    expect(logger.info).toHaveBeenCalledWith(
      "memory-core: migrated 2 legacy phase dreaming cron job(s) to the unified dreaming controller.",
    );
  });

  it("migrates legacy phase jobs even when unified dreaming is disabled", async () => {
    const legacyLightJob: CronJobLike = {
      id: "job-light",
      name: "Memory Light Dreaming",
      description: "[managed-by=memory-core.dreaming.light] legacy",
      enabled: true,
      schedule: { kind: "cron", expr: "0 */6 * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "__openclaw_memory_core_light_sleep__" },
      createdAtMs: 8,
    };
    const harness = createCronHarness([legacyLightJob]);
    const logger = createLogger();

    const result = await reconcileShortTermDreamingCronJob({
      cron: harness.cron,
      config: {
        enabled: false,
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        limit: constants.DEFAULT_DREAMING_LIMIT,
        minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
        minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
        minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
    });

    expect(result).toEqual({ status: "disabled", removed: 1 });
    expect(harness.removeCalls).toEqual(["job-light"]);
    expect(logger.info).toHaveBeenCalledWith(
      "memory-core: completed legacy phase dreaming cron migration while unified dreaming is disabled (1 job(s) removed).",
    );
  });

  it("does not overcount removed jobs when cron remove result is unknown", async () => {
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
    const harness = createCronHarness([managedJob], { removeResult: "unknown" });
    const logger = createLogger();

    const result = await reconcileShortTermDreamingCronJob({
      cron: harness.cron,
      config: {
        enabled: false,
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        limit: constants.DEFAULT_DREAMING_LIMIT,
        minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
        minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
        minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
    });

    expect(result.removed).toBe(0);
    expect(harness.removeCalls).toEqual(["job-managed"]);
  });

  it("warns and continues when disabling managed jobs hits a remove error", async () => {
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
    const harness = createCronHarness([managedJob], { removeThrowsForIds: ["job-managed"] });
    const logger = createLogger();

    const result = await reconcileShortTermDreamingCronJob({
      cron: harness.cron,
      config: {
        enabled: false,
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        limit: constants.DEFAULT_DREAMING_LIMIT,
        minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
        minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
        minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
    });

    expect(result).toEqual({ status: "disabled", removed: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to remove managed dreaming cron job job-managed"),
    );
  });
});

describe("gateway startup reconciliation", () => {
  it("uses the startup cfg when reconciling the managed dreaming cron job", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const api: DreamingPluginApiTestDouble = {
      config: { plugins: { entries: {} } },
      pluginConfig: {},
      logger,
      runtime: {},
      registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => {
        registerInternalHook(event, handler);
      },
      on: vi.fn(),
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerInternalHook(
        createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: {
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
          deps: { cron: harness.cron },
        }),
      );

      expect(harness.addCalls).toHaveLength(1);
      expect(harness.addCalls[0]).toMatchObject({
        schedule: {
          kind: "cron",
          expr: "15 4 * * *",
          tz: "UTC",
        },
      });
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("created managed dreaming cron job"),
      );
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
      registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => {
        registerInternalHook(event, handler);
      },
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      const deps = { cron: harness.cron };
      await triggerInternalHook(
        createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: api.config,
          deps,
        }),
      );

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
      expect(harness.addCalls[0]?.schedule).toMatchObject({
        kind: "cron",
        expr: "30 6 * * *",
        tz: "America/New_York",
      });
    } finally {
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
      registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => {
        registerInternalHook(event, handler);
      },
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      const deps = { cron: startupHarness.cron };
      await triggerInternalHook(
        createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: api.config,
          deps,
        }),
      );

      expect(startupHarness.addCalls).toHaveLength(1);
      const managed = startupHarness.jobs.find((job) =>
        job.description?.includes("[managed-by=memory-core.short-term-promotion]"),
      );
      expect(managed).toBeDefined();

      const reloadedHarness = createCronHarness(
        managed
          ? [
              {
                ...managed,
                schedule: managed.schedule ? { ...managed.schedule } : undefined,
                payload: managed.payload ? { ...managed.payload } : undefined,
              },
            ]
          : [],
      );
      deps.cron = reloadedHarness.cron;
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
      expect(reloadedHarness.updateCalls[0]?.patch.schedule).toMatchObject({
        kind: "cron",
        expr: "45 8 * * *",
        tz: "America/Los_Angeles",
      });
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
      registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => {
        registerInternalHook(event, handler);
      },
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerInternalHook(
        createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: api.config,
          deps: { cron: harness.cron },
        }),
      );
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
      expect(harness.addCalls[1]?.schedule).toMatchObject({
        kind: "cron",
        expr: "0 2 * * *",
        tz: "UTC",
      });
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
      registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => {
        registerInternalHook(event, handler);
      },
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerInternalHook(
        createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: api.config,
          deps: { cron: harness.cron },
        }),
      );

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
      registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => {
        registerInternalHook(event, handler);
      },
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerInternalHook(
        createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: api.config,
          deps: { cron: harness.cron },
        }),
      );

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
      registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => {
        registerInternalHook(event, handler);
      },
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerInternalHook(
        createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: api.config,
          deps: { cron: harness.cron },
        }),
      );

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
      registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => {
        registerInternalHook(event, handler);
      },
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerInternalHook(
        createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: api.config,
          deps: { cron: harness.cron },
        }),
      );

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

  it("does not emit the cron-unavailable warning on gateway:startup when deps.cron is missing (regression #69939)", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const api: DreamingPluginApiTestDouble = {
      config: { plugins: { entries: {} } },
      pluginConfig: {},
      logger,
      runtime: {},
      registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => {
        registerInternalHook(event, handler);
      },
      on: vi.fn(),
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      // Simulate the startup race: gateway:startup fires before deps.cron is attached.
      await triggerInternalHook(
        createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: {
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
          deps: {},
        }),
      );

      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("cron service unavailable"),
      );
      // The startup-path log should be demoted to debug instead.
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("cron service not yet available at gateway:startup"),
      );
    } finally {
      clearInternalHooks();
    }
  });

  it("still warns on runtime reconciliation when cron remains unavailable (preserves #69939 genuine-failure signal)", async () => {
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
      registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => {
        registerInternalHook(event, handler);
      },
      on: onMock,
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      // Startup without cron — must stay silent on warn.
      await triggerInternalHook(
        createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: api.config,
          deps: {},
        }),
      );
      expect(logger.warn).not.toHaveBeenCalled();

      // Now a runtime heartbeat reconciliation happens and cron is still missing
      // (e.g. the cron service genuinely failed to initialize). The warning must fire.
      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      await beforeAgentReply(
        { cleanedBody: "" },
        { trigger: "heartbeat", workspaceDir: ".", sessionKey: "agent:main:main:heartbeat" },
      );

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("cron service unavailable"));
    } finally {
      clearInternalHooks();
    }
  });
});

describe("short-term dreaming trigger", () => {
  it("applies promotions when the managed dreaming heartbeat event fires", async () => {
    const logger = createLogger();
    const workspaceDir = await createTempWorkspace("memory-dreaming-");
    await writeDailyMemoryNote(workspaceDir, "2026-04-02", ["Move backups to S3 Glacier."]);

    await recordShortTermRecalls({
      workspaceDir,
      query: "backup policy",
      results: [
        {
          path: "memory/2026-04-02.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "Move backups to S3 Glacier.",
          source: "memory",
        },
      ],
    });

    const result = await runShortTermDreamingPromotionIfTriggered({
      cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT,
      trigger: "heartbeat",
      workspaceDir,
      config: {
        enabled: true,
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        limit: 10,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
    });

    expect(result?.handled).toBe(true);
    const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memoryText).toContain("Move backups to S3 Glacier.");
  });

  it("applies promotions when the managed dreaming token is embedded in a reminder body", async () => {
    const logger = createLogger();
    const workspaceDir = await createTempWorkspace("memory-dreaming-composite-");
    await writeDailyMemoryNote(workspaceDir, "2026-04-02", ["Move backups to S3 Glacier."]);

    await recordShortTermRecalls({
      workspaceDir,
      query: "backup policy",
      results: [
        {
          path: "memory/2026-04-02.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "Move backups to S3 Glacier.",
          source: "memory",
        },
      ],
    });

    const result = await runShortTermDreamingPromotionIfTriggered({
      cleanedBody: [
        "System: rotate logs",
        "System: __openclaw_memory_core_short_term_promotion_dream__",
        "",
        "A scheduled reminder has been triggered. The reminder content is:",
        "",
        "rotate logs",
        "__openclaw_memory_core_short_term_promotion_dream__",
        "",
        "Handle this reminder internally. Do not relay it to the user unless explicitly requested.",
      ].join("\n"),
      trigger: "heartbeat",
      workspaceDir,
      config: {
        enabled: true,
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        limit: 10,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
    });

    expect(result?.handled).toBe(true);
    const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memoryText).toContain("Move backups to S3 Glacier.");
  });

  it("keeps one-off recalls out of long-term memory under default thresholds", async () => {
    const logger = createLogger();
    const workspaceDir = await createTempWorkspace("memory-dreaming-strict-");
    await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
      "Move backups to S3 Glacier.",
      "Retain quarterly snapshots.",
    ]);

    await recordShortTermRecalls({
      workspaceDir,
      query: "glacier",
      results: [
        {
          path: "memory/2026-04-03.md",
          startLine: 1,
          endLine: 2,
          score: 0.95,
          snippet: "Move backups to S3 Glacier.",
          source: "memory",
        },
      ],
    });

    const result = await runShortTermDreamingPromotionIfTriggered({
      cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT,
      trigger: "heartbeat",
      workspaceDir,
      config: {
        enabled: true,
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        limit: constants.DEFAULT_DREAMING_LIMIT,
        minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
        minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
        minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
    });

    expect(result?.handled).toBe(true);
    const memoryText = await fs
      .readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8")
      .catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return "";
        }
        throw err;
      });
    expect(memoryText).toBe("");
  });

  it("ignores non-heartbeat triggers", async () => {
    const logger = createLogger();
    const result = await runShortTermDreamingPromotionIfTriggered({
      cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT,
      trigger: "user",
      workspaceDir: "/tmp/workspace",
      config: {
        enabled: true,
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        limit: 10,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
    });
    expect(result).toBeUndefined();
  });

  it("skips dreaming promotion cleanly when limit is zero", async () => {
    const logger = createLogger();
    const workspaceDir = await createTempWorkspace("memory-dreaming-limit-zero-");

    const result = await runShortTermDreamingPromotionIfTriggered({
      cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT,
      trigger: "heartbeat",
      workspaceDir,
      config: {
        enabled: true,
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        limit: 0,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
    });

    expect(result).toEqual({
      handled: true,
      reason: "memory-core: short-term dreaming disabled by limit",
    });
    expect(logger.info).toHaveBeenCalledWith(
      "memory-core: dreaming promotion skipped because limit=0.",
    );
    await expect(fs.access(path.join(workspaceDir, "MEMORY.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("repairs recall artifacts before dreaming promotion runs", async () => {
    const logger = createLogger();
    const workspaceDir = await createTempWorkspace("memory-dreaming-repair-");
    await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
      "Move backups to S3 Glacier and sync router failover notes.",
      "Keep router recovery docs current.",
    ]);
    const storePath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-04-01T00:00:00.000Z",
          entries: {
            "memory:memory/2026-04-03.md:1:2": {
              key: "memory:memory/2026-04-03.md:1:2",
              path: "memory/2026-04-03.md",
              startLine: 1,
              endLine: 2,
              source: "memory",
              snippet: "Move backups to S3 Glacier and sync router failover notes.",
              recallCount: 3,
              totalScore: 2.7,
              maxScore: 0.95,
              firstRecalledAt: "2026-04-01T00:00:00.000Z",
              lastRecalledAt: "2026-04-03T00:00:00.000Z",
              queryHashes: ["abc", "abc", "def"],
              recallDays: ["2026-04-01", "2026-04-01", "2026-04-03"],
              conceptTags: [],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const result = await runShortTermDreamingPromotionIfTriggered({
      cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT,
      trigger: "heartbeat",
      workspaceDir,
      config: {
        enabled: true,
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        limit: 10,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
    });

    expect(result?.handled).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("normalized recall artifacts before dreaming"),
    );
    const repaired = JSON.parse(await fs.readFile(storePath, "utf-8")) as {
      entries: Record<
        string,
        { queryHashes?: string[]; recallDays?: string[]; conceptTags?: string[] }
      >;
    };
    expect(repaired.entries["memory:memory/2026-04-03.md:1:2"]?.queryHashes).toEqual([
      "abc",
      "def",
    ]);
    expect(repaired.entries["memory:memory/2026-04-03.md:1:2"]?.recallDays).toEqual([
      "2026-04-01",
      "2026-04-03",
    ]);
    expect(repaired.entries["memory:memory/2026-04-03.md:1:2"]?.conceptTags).toEqual(
      expect.arrayContaining(["glacier", "router", "failover"]),
    );
  });

  it("emits detailed run logs when verboseLogging is enabled", async () => {
    const logger = createLogger();
    const workspaceDir = await createTempWorkspace("memory-dreaming-verbose-");
    await writeDailyMemoryNote(workspaceDir, "2026-04-02", ["Move backups to S3 Glacier."]);

    await recordShortTermRecalls({
      workspaceDir,
      query: "backup policy",
      results: [
        {
          path: "memory/2026-04-02.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "Move backups to S3 Glacier.",
          source: "memory",
        },
      ],
    });

    const result = await runShortTermDreamingPromotionIfTriggered({
      cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT,
      trigger: "heartbeat",
      workspaceDir,
      config: {
        enabled: true,
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        limit: 10,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: true,
      },
      logger,
    });

    expect(result?.handled).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("memory-core: dreaming verbose enabled"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("memory-core: dreaming candidate details"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("memory-core: dreaming applied details"),
    );
  });

  it("fans out one dreaming run across configured agent workspaces", async () => {
    const logger = createLogger();
    const workspaceRoot = await createTempWorkspace("memory-dreaming-multi-");
    const alphaWorkspace = path.join(workspaceRoot, "alpha");
    const betaWorkspace = path.join(workspaceRoot, "beta");

    await writeDailyMemoryNote(alphaWorkspace, "2026-04-02", ["Alpha backup note."]);
    await writeDailyMemoryNote(betaWorkspace, "2026-04-02", ["Beta router note."]);
    await recordShortTermRecalls({
      workspaceDir: alphaWorkspace,
      query: "alpha backup",
      results: [
        {
          path: "memory/2026-04-02.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "Alpha backup note.",
          source: "memory",
        },
      ],
    });
    await recordShortTermRecalls({
      workspaceDir: betaWorkspace,
      query: "beta router",
      results: [
        {
          path: "memory/2026-04-02.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "Beta router note.",
          source: "memory",
        },
      ],
    });

    const result = await runShortTermDreamingPromotionIfTriggered({
      cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT,
      trigger: "heartbeat",
      workspaceDir: alphaWorkspace,
      cfg: {
        agents: {
          defaults: {
            memorySearch: {
              enabled: true,
            },
          },
          list: [
            {
              id: "alpha",
              workspace: alphaWorkspace,
            },
            {
              id: "beta",
              workspace: betaWorkspace,
            },
          ],
        },
      } as OpenClawConfig,
      config: {
        enabled: true,
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        limit: 10,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
    });

    expect(result?.handled).toBe(true);
    expect(await fs.readFile(path.join(alphaWorkspace, "MEMORY.md"), "utf-8")).toContain(
      "Alpha backup note.",
    );
    expect(await fs.readFile(path.join(betaWorkspace, "MEMORY.md"), "utf-8")).toContain(
      "Beta router note.",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "memory-core: dreaming promotion complete (workspaces=2, candidates=2, applied=2, failed=0).",
    );
  });
});
