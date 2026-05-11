import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronServiceContract } from "../../cron/service-contract.js";
import type { CronJob, CronJobCreate } from "../../cron/types.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
} from "../../gateway/server-methods/types.js";
import { withEnv } from "../../test-utils/env.js";
import { cleanupReplacedPluginHostRegistry } from "../host-hook-cleanup.js";
import {
  clearPluginHostRuntimeState,
  cleanupPluginSessionSchedulerJobs,
  listPluginSessionSchedulerJobs,
} from "../host-hook-runtime.js";
import {
  buildPluginSchedulerCronName,
  schedulePluginSessionTurn,
  unschedulePluginSessionTurnsByTag,
} from "../host-hook-scheduled-turns.js";
import { clearPluginLoaderCache, loadOpenClawPlugins } from "../loader.js";
import { makeTempDir, writePlugin } from "../loader.test-fixtures.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type { OpenClawPluginApi } from "../types.js";

const workflowMocks = vi.hoisted(() => ({
  cronAdd: vi.fn(),
  cronListPage: vi.fn(),
  cronRemove: vi.fn(),
}));

const WORKFLOW_PLUGIN_ID = "workflow-plugin";
const MAIN_SESSION_KEY = "agent:main:main";
const DEFAULT_TURN_SCHEDULE = {
  sessionKey: MAIN_SESSION_KEY,
  message: "wake",
  delayMs: 1_000,
} as const;

type ScheduleSessionTurnRequest = Parameters<typeof schedulePluginSessionTurn>[0];
type SessionTurnSchedule = ScheduleSessionTurnRequest["schedule"];

async function invokePluginGatewayHandler(params: {
  handler: GatewayRequestHandler;
  method: string;
  params?: Record<string, unknown>;
}): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const handlerParams = params.params ?? {};
    const respond = (
      ok: boolean,
      payload?: unknown,
      error?: { message?: string },
      meta?: Record<string, unknown>,
    ) => {
      void meta;
      if (ok) {
        resolve(payload);
        return;
      }
      reject(new Error(error?.message ?? `gateway handler failed: ${params.method}`));
    };
    // Keep this helper pinned to the live request-frame contract so gateway typing drift breaks here first.
    const handlerOptions: GatewayRequestHandlerOptions = {
      req: {
        type: "req",
        id: "test-request",
        method: params.method,
        params: handlerParams,
      },
      params: handlerParams,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as GatewayRequestHandlerOptions["context"],
    };
    Promise.resolve(params.handler(handlerOptions)).catch(reject);
  });
}

function createMockCronService(): CronServiceContract {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    status: vi.fn(async () => ({
      enabled: true,
      storePath: "/tmp/openclaw-test-cron.json",
      jobs: 0,
      nextWakeAtMs: null,
    })),
    list: vi.fn(async () => []),
    listPage: workflowMocks.cronListPage,
    add: workflowMocks.cronAdd,
    update: vi.fn(async (id, patch) => makeCronJob({ id, ...patch })),
    remove: workflowMocks.cronRemove,
    run: vi.fn(async () => ({ ok: true, ran: false, reason: "not-due" })),
    enqueueRun: vi.fn(async () => ({ ok: true, ran: false, reason: "not-due" })),
    getJob: vi.fn(() => undefined),
    getDefaultAgentId: vi.fn(() => undefined),
    wake: vi.fn(() => ({ ok: true })),
  } as CronServiceContract;
}

function makeCronJob(input: Partial<CronJob> & { id: string }): CronJob {
  return {
    name: input.name ?? input.id,
    enabled: true,
    schedule: { kind: "at", at: "2026-05-01T00:00:00.000Z" },
    sessionTarget: input.sessionTarget ?? `session:${MAIN_SESSION_KEY}`,
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "wake" },
    delivery: { mode: "announce", channel: "last" },
    state: {},
    createdAtMs: 0,
    updatedAtMs: 0,
    ...input,
  };
}

const cron = createMockCronService();

function mockCronAdd(response: CronJob) {
  workflowMocks.cronAdd.mockResolvedValue(response);
}

function getCronAddBody() {
  const addCall = workflowMocks.cronAdd.mock.calls[0];
  expect(addCall).toBeDefined();
  return addCall?.[0] as CronJobCreate;
}

function expectSessionTurnHandle(
  handle: unknown,
  id: string,
  pluginId = WORKFLOW_PLUGIN_ID,
  sessionKey = MAIN_SESSION_KEY,
) {
  expect(handle).toEqual({
    id,
    pluginId,
    sessionKey,
    kind: "session-turn",
  });
}

async function scheduleWorkflowTurn(
  params: Omit<ScheduleSessionTurnRequest, "pluginId" | "origin" | "schedule"> & {
    origin?: ScheduleSessionTurnRequest["origin"];
    schedule?: Partial<SessionTurnSchedule>;
  } = {},
) {
  const { origin = "bundled", schedule, ...rest } = params;
  return await schedulePluginSessionTurn({
    pluginId: WORKFLOW_PLUGIN_ID,
    origin,
    schedule: { ...DEFAULT_TURN_SCHEDULE, ...schedule } as SessionTurnSchedule,
    cron: params.cron ?? cron,
    ...rest,
  });
}

async function unscheduleWorkflowTurnsByTag(
  request: Parameters<typeof unschedulePluginSessionTurnsByTag>[0]["request"] = {
    sessionKey: MAIN_SESSION_KEY,
    tag: "nudge",
  },
  origin: Parameters<typeof unschedulePluginSessionTurnsByTag>[0]["origin"] = "bundled",
) {
  return await unschedulePluginSessionTurnsByTag({
    pluginId: WORKFLOW_PLUGIN_ID,
    origin,
    cron,
    request,
  });
}

describe("plugin scheduled turns", () => {
  beforeEach(() => {
    workflowMocks.cronAdd.mockReset();
    workflowMocks.cronListPage.mockReset();
    workflowMocks.cronRemove.mockReset();
    workflowMocks.cronListPage.mockResolvedValue({
      jobs: [],
      total: 0,
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
    });
    workflowMocks.cronRemove.mockResolvedValue({ ok: true, removed: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearPluginLoaderCache();
    clearPluginHostRuntimeState();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("builds tagged and untagged cron names", () => {
    expect(
      buildPluginSchedulerCronName({
        pluginId: WORKFLOW_PLUGIN_ID,
        sessionKey: MAIN_SESSION_KEY,
        tag: "nudge",
        uniqueId: "abc",
      }),
    ).toBe("plugin:workflow-plugin:tag:nudge:agent:main:main:abc");
    expect(
      buildPluginSchedulerCronName({
        pluginId: WORKFLOW_PLUGIN_ID,
        sessionKey: MAIN_SESSION_KEY,
        uniqueId: "xyz",
      }),
    ).toBe("plugin:workflow-plugin:agent:main:main:xyz");
  });

  it("schedules session turns with cron-compatible tagged cleanup metadata", async () => {
    mockCronAdd(makeCronJob({ id: "job-tagged" }));

    const handle = await scheduleWorkflowTurn({
      pluginName: "Workflow Plugin",
      schedule: {
        tag: "nudge",
        name: "custom-nudge-name",
        deliveryMode: "announce",
      },
    });

    expect(handle).toEqual({
      id: "job-tagged",
      pluginId: WORKFLOW_PLUGIN_ID,
      sessionKey: MAIN_SESSION_KEY,
      kind: "session-turn",
    });
    const job = getCronAddBody();
    expect(job.name).toBe("plugin:workflow-plugin:tag:nudge:agent:main:main:custom-nudge-name");
    expect(job.sessionTarget).toBe("session:agent:main:main");
    expect(job.deleteAfterRun).toBe(true);
    expect(job.delivery).toEqual({ mode: "announce", channel: "last" });
    expect(job.payload).toEqual({ kind: "agentTurn", message: "wake" });
    expect(listPluginSessionSchedulerJobs(WORKFLOW_PLUGIN_ID)).toHaveLength(1);
  });

  it("prefixes explicit untagged schedule names with plugin ownership metadata", async () => {
    mockCronAdd(makeCronJob({ id: "job-untagged" }));

    const handle = await scheduleWorkflowTurn({
      schedule: {
        name: "daily-nudge",
      },
    });
    expectSessionTurnHandle(handle, "job-untagged");

    expect(getCronAddBody().name).toBe("plugin:workflow-plugin:agent:main:main:daily-nudge");
  });

  it("builds payloads accepted by the real cron.add protocol validator", async () => {
    const { validateCronAddParams } = await import("../../gateway/protocol/index.js");
    workflowMocks.cronAdd.mockImplementation(async (body: unknown) => {
      expect(validateCronAddParams(body)).toBe(true);
      expect((body as { delivery?: unknown }).delivery).toEqual({
        mode: "announce",
        channel: "last",
      });
      return makeCronJob({ id: "cron-compatible-job" });
    });

    const handle = await scheduleWorkflowTurn({
      schedule: {
        tag: "nudge",
      },
    });
    expectSessionTurnHandle(handle, "cron-compatible-job");
  });

  it("pages through cron.list when unscheduling tagged turns", async () => {
    const removed: string[] = [];
    const listRequests: unknown[] = [];
    workflowMocks.cronListPage.mockImplementation(async (body: unknown) => {
      const offset = (body as { offset?: unknown }).offset;
      listRequests.push(body);
      if (offset === undefined) {
        return {
          jobs: [
            makeCronJob({
              id: "job-page-1",
              name: "plugin:workflow-plugin:tag:nudge:agent:main:main:1",
              sessionTarget: "session:agent:main:main",
            }),
          ],
          total: 2,
          offset: 0,
          limit: 200,
          hasMore: true,
          nextOffset: 200,
        };
      }
      return {
        jobs: [
          makeCronJob({
            id: "job-page-2",
            name: "plugin:workflow-plugin:tag:nudge:agent:main:main:2",
            sessionTarget: "session:agent:main:main",
          }),
        ],
        total: 2,
        offset: 200,
        limit: 200,
        hasMore: false,
        nextOffset: null,
      };
    });
    workflowMocks.cronRemove.mockImplementation(async (id: string) => {
      removed.push(id);
      return { ok: true, removed: true };
    });

    await expect(unscheduleWorkflowTurnsByTag()).resolves.toEqual({ removed: 2, failed: 0 });
    expect(listRequests).toEqual([
      {
        includeDisabled: true,
        limit: 200,
        query: "plugin:workflow-plugin:tag:nudge:agent:main:main:",
        sortBy: "name",
        sortDir: "asc",
      },
      {
        includeDisabled: true,
        limit: 200,
        offset: 200,
        query: "plugin:workflow-plugin:tag:nudge:agent:main:main:",
        sortBy: "name",
        sortDir: "asc",
      },
    ]);
    expect(removed.toSorted()).toEqual(["job-page-1", "job-page-2"]);
  });

  it("tracks scheduled session turns using cron.add's top-level job id", async () => {
    workflowMocks.cronAdd.mockResolvedValueOnce(makeCronJob({ id: "cron-top-level-id" }));

    await expect(
      scheduleWorkflowTurn({
        pluginName: "Workflow Plugin",
      }),
    ).resolves.toEqual({
      id: "cron-top-level-id",
      pluginId: WORKFLOW_PLUGIN_ID,
      sessionKey: MAIN_SESSION_KEY,
      kind: "session-turn",
    });
    expect(listPluginSessionSchedulerJobs(WORKFLOW_PLUGIN_ID)).toEqual([
      {
        id: "cron-top-level-id",
        pluginId: WORKFLOW_PLUGIN_ID,
        sessionKey: MAIN_SESSION_KEY,
        kind: "session-turn",
      },
    ]);
  });

  it("keeps one-shot scheduled-turn records until cleanup confirms the job is gone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
    const removed: string[] = [];
    workflowMocks.cronAdd.mockResolvedValue(makeCronJob({ id: "one-shot-job" }));
    workflowMocks.cronRemove.mockImplementation(async (id: string) => {
      removed.push(id);
      return { ok: true, removed: false };
    });

    await expect(
      scheduleWorkflowTurn({
        pluginName: "Workflow Plugin",
      }),
    ).resolves.toEqual({
      id: "one-shot-job",
      pluginId: WORKFLOW_PLUGIN_ID,
      sessionKey: MAIN_SESSION_KEY,
      kind: "session-turn",
    });
    expect(listPluginSessionSchedulerJobs(WORKFLOW_PLUGIN_ID)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_999);
    expect(listPluginSessionSchedulerJobs(WORKFLOW_PLUGIN_ID)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(listPluginSessionSchedulerJobs(WORKFLOW_PLUGIN_ID)).toHaveLength(1);

    await expect(
      cleanupPluginSessionSchedulerJobs({
        pluginId: WORKFLOW_PLUGIN_ID,
        reason: "disable",
      }),
    ).resolves.toEqual([]);
    expect(removed).toEqual(["one-shot-job"]);
    expect(listPluginSessionSchedulerJobs(WORKFLOW_PLUGIN_ID)).toEqual([]);
  });

  it("rejects invalid schedules, unsupported delivery modes, and ambiguous tags before cron.add", async () => {
    await expect(
      schedulePluginSessionTurn({
        pluginId: "workflow-plugin",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: -1,
        },
      }),
    ).resolves.toBeUndefined();

    await expect(
      schedulePluginSessionTurn({
        pluginId: "workflow-plugin",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: 1_000,
          deliveryMode: "unsupported" as never,
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      schedulePluginSessionTurn({
        pluginId: "workflow-plugin",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          cron: "*/5 * * * *",
          deleteAfterRun: true,
        } as never,
      }),
    ).resolves.toBeUndefined();
    await expect(
      schedulePluginSessionTurn({
        pluginId: "workflow-plugin",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: 1_000,
          tag: "nudge:followup",
        },
      }),
    ).resolves.toBeUndefined();
    expect(workflowMocks.cronAdd).not.toHaveBeenCalled();
  });

  it("falls back to a valid delay schedule when a malformed cron value is absent", async () => {
    mockCronAdd(makeCronJob({ id: "delay-job" }));

    const handle = await scheduleWorkflowTurn({
      schedule: {
        cron: undefined,
      } as never,
    });
    expectSessionTurnHandle(handle, "delay-job");

    expect((getCronAddBody() as { schedule?: { kind?: string } }).schedule?.kind).toBe("at");
  });

  it("removes a stale cron job when the plugin unloads after cron.add", async () => {
    let commit = true;
    const removed: string[] = [];
    workflowMocks.cronAdd.mockImplementation(async () => {
      commit = false;
      return makeCronJob({ id: "job-stale" });
    });
    workflowMocks.cronRemove.mockImplementation(async (id: string) => {
      removed.push(id);
      return { ok: true, removed: true };
    });

    await expect(
      scheduleWorkflowTurn({
        schedule: { delayMs: 1 },
        shouldCommit: () => commit,
      }),
    ).resolves.toBeUndefined();
    expect(removed).toEqual(["job-stale"]);
    expect(listPluginSessionSchedulerJobs(WORKFLOW_PLUGIN_ID)).toEqual([]);
  });

  it("allows bundled plugins to schedule turns during real plugin registration", async () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "loader-scheduler",
      dir: bundledDir,
      filename: "index.cjs",
      body: `module.exports = {
  id: "loader-scheduler",
  register(api) {
    void api.session.workflow.scheduleSessionTurn({
      sessionKey: "agent:main:main",
      message: "wake",
      delayMs: 1
    });
  }
};`,
    });
    workflowMocks.cronAdd.mockResolvedValue(makeCronJob({ id: "loader-scheduled-job" }));
    workflowMocks.cronRemove.mockResolvedValue({ ok: true, removed: true });

    const registry = withEnv(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
      () =>
        loadOpenClawPlugins({
          cache: false,
          hostServices: { cron },
          config: {
            plugins: {
              enabled: true,
              entries: {
                "loader-scheduler": {
                  enabled: true,
                },
              },
            },
          },
        }),
    );

    expect(registry.plugins.find((plugin) => plugin.id === "loader-scheduler")?.status).toBe(
      "loaded",
    );
    await vi.waitFor(() => expect(workflowMocks.cronAdd).toHaveBeenCalledTimes(1));
    const { name, schedule, ...stableCronAddBody } = getCronAddBody();
    expect(typeof name).toBe("string");
    expect(name.startsWith("plugin:loader-scheduler:agent:main:main:")).toBe(true);
    if (schedule.kind !== "at") {
      throw new Error(`Expected one-shot scheduled turn, got ${schedule.kind}`);
    }
    expect(typeof schedule.at).toBe("string");
    expect(stableCronAddBody).toEqual({
      enabled: true,
      sessionTarget: "session:agent:main:main",
      payload: { kind: "agentTurn", message: "wake" },
      deleteAfterRun: true,
      wakeMode: "now",
      delivery: {
        mode: "announce",
        channel: "last",
      },
    });
    expect(listPluginSessionSchedulerJobs("loader-scheduler")).toEqual([
      {
        id: "loader-scheduled-job",
        pluginId: "loader-scheduler",
        sessionKey: "agent:main:main",
        kind: "session-turn",
      },
    ]);
  });

  it("keeps late scheduled-turn helpers callable from real plugin gateway handlers", async () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "loader-scheduler-runtime",
      dir: bundledDir,
      filename: "index.cjs",
      body: `module.exports = {
  id: "loader-scheduler-runtime",
  register(api) {
    const scheduleSessionTurn = api.session.workflow.scheduleSessionTurn;
    const unscheduleSessionTurnsByTag = api.session.workflow.unscheduleSessionTurnsByTag;
    api.registerGatewayMethod("loader-scheduler-runtime.exercise", async ({ respond }) => {
      const first = await scheduleSessionTurn({
        sessionKey: "agent:main:main",
        message: "wake one",
        delayMs: 1,
        tag: "nudge",
      });
      const second = await scheduleSessionTurn({
        sessionKey: "agent:main:main",
        message: "wake two",
        delayMs: 1,
        tag: "nudge",
        deliveryMode: "none",
      });
      const badTag = await scheduleSessionTurn({
        sessionKey: "agent:main:main",
        message: "bad tag",
        delayMs: 1,
        tag: "bad:tag",
      });
      const badDelete = await scheduleSessionTurn({
        sessionKey: "agent:main:main",
        message: "bad delete",
        cron: "0 * * * *",
        deleteAfterRun: true,
        tag: "nudge",
      });
      const removed = await unscheduleSessionTurnsByTag({
        sessionKey: "agent:main:main",
        tag: "nudge",
      });
      respond(true, {
        first,
        second,
        badTag: badTag ?? null,
        badDelete: badDelete ?? null,
        removed: removed ?? null,
      });
    });
  },
};`,
    });
    const addedJobs: Array<Record<string, unknown>> = [];
    const removedJobIds = new Set<string>();
    workflowMocks.cronAdd.mockImplementation(async (body: CronJobCreate) => {
      const id = `loader-scheduled-job-${addedJobs.length + 1}`;
      addedJobs.push({
        id,
        ...(body as Record<string, unknown>),
      });
      return makeCronJob({ id, ...body });
    });
    workflowMocks.cronListPage.mockImplementation(async () => ({
      jobs: addedJobs
        .filter((job) => {
          const id = typeof job.id === "string" ? job.id : "";
          return id && !removedJobIds.has(id);
        })
        .map((job) => makeCronJob(job as Partial<CronJob> & { id: string })),
      total: addedJobs.length,
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
    }));
    workflowMocks.cronRemove.mockImplementation(async (id: string) => {
      if (id) {
        removedJobIds.add(id);
      }
      return { ok: true, removed: true };
    });

    const registry = withEnv(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
      () =>
        loadOpenClawPlugins({
          cache: false,
          hostServices: { cron },
          config: {
            plugins: {
              enabled: true,
              entries: {
                "loader-scheduler-runtime": {
                  enabled: true,
                },
              },
            },
          },
        }),
    );

    expect(
      registry.plugins.find((plugin) => plugin.id === "loader-scheduler-runtime")?.status,
    ).toBe("loaded");
    const handler = registry.gatewayHandlers["loader-scheduler-runtime.exercise"];
    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("missing loader-scheduler-runtime.exercise gateway handler");
    }

    await expect(
      invokePluginGatewayHandler({
        handler,
        method: "loader-scheduler-runtime.exercise",
      }),
    ).resolves.toEqual({
      first: {
        id: "loader-scheduled-job-1",
        pluginId: "loader-scheduler-runtime",
        sessionKey: "agent:main:main",
        kind: "session-turn",
      },
      second: {
        id: "loader-scheduled-job-2",
        pluginId: "loader-scheduler-runtime",
        sessionKey: "agent:main:main",
        kind: "session-turn",
      },
      badTag: null,
      badDelete: null,
      removed: { removed: 2, failed: 0 },
    });
    const namePrefix = "plugin:loader-scheduler-runtime:tag:nudge:agent:main:main:";
    const addedNames = addedJobs.map((job) => job.name);
    expect(addedNames).toHaveLength(2);
    expect(addedNames[0]).toMatch(
      /^plugin:loader-scheduler-runtime:tag:nudge:agent:main:main:[0-9a-f-]{36}$/u,
    );
    expect(addedNames[1]).toMatch(
      /^plugin:loader-scheduler-runtime:tag:nudge:agent:main:main:[0-9a-f-]{36}$/u,
    );
    expect(String(addedNames[0]).startsWith(namePrefix)).toBe(true);
    expect(String(addedNames[1]).startsWith(namePrefix)).toBe(true);
    expect(addedNames[0]).not.toBe(addedNames[1]);
    expect(addedJobs.map((job) => job.delivery)).toEqual([
      { mode: "announce", channel: "last" },
      { mode: "none" },
    ]);
    expect(listPluginSessionSchedulerJobs("loader-scheduler-runtime")).toEqual([]);
  });

  it("keeps stale scheduled-turn rollback non-throwing when cron cleanup fails", async () => {
    let commit = true;
    workflowMocks.cronAdd.mockImplementation(async () => {
      commit = false;
      return makeCronJob({ id: "job-stale" });
    });
    workflowMocks.cronRemove.mockImplementation(async (id: string) => {
      throw new Error(`remove failed for ${id}`);
    });

    await expect(
      scheduleWorkflowTurn({
        schedule: { delayMs: 1 },
        shouldCommit: () => commit,
      }),
    ).resolves.toBeUndefined();
    expect(listPluginSessionSchedulerJobs(WORKFLOW_PLUGIN_ID)).toEqual([]);
  });

  it("keeps scheduled-turn records when cleanup fails", async () => {
    workflowMocks.cronAdd.mockResolvedValue(makeCronJob({ id: "cleanup-failure-job" }));
    workflowMocks.cronRemove.mockImplementation(async (id: string) => {
      throw new Error(`remove failed for ${id}`);
    });

    const cleanupFailureHandle = await scheduleWorkflowTurn({
      pluginName: "Workflow Plugin",
    });
    expectSessionTurnHandle(cleanupFailureHandle, "cleanup-failure-job");

    const failures = await cleanupPluginSessionSchedulerJobs({
      pluginId: WORKFLOW_PLUGIN_ID,
      reason: "disable",
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.pluginId).toBe(WORKFLOW_PLUGIN_ID);
    expect(failures[0]?.hookId).toBe("scheduler:cleanup-failure-job");
    expect(listPluginSessionSchedulerJobs(WORKFLOW_PLUGIN_ID)).toEqual([
      {
        id: "cleanup-failure-job",
        pluginId: WORKFLOW_PLUGIN_ID,
        sessionKey: MAIN_SESSION_KEY,
        kind: "session-turn",
      },
    ]);
  });

  it("cleans live dynamic scheduled turns when registry cleanup records are empty", async () => {
    const removed: string[] = [];
    workflowMocks.cronAdd.mockResolvedValue(makeCronJob({ id: "dynamic-cleanup-job" }));
    workflowMocks.cronRemove.mockImplementation(async (id: string) => {
      removed.push(id);
      return { ok: true, removed: true };
    });

    const dynamicCleanupHandle = await scheduleWorkflowTurn();
    expectSessionTurnHandle(dynamicCleanupHandle, "dynamic-cleanup-job");

    await expect(
      cleanupPluginSessionSchedulerJobs({
        pluginId: WORKFLOW_PLUGIN_ID,
        reason: "restart",
        records: [],
      }),
    ).resolves.toEqual([]);
    expect(removed).toEqual(["dynamic-cleanup-job"]);
    expect(listPluginSessionSchedulerJobs(WORKFLOW_PLUGIN_ID)).toEqual([]);
  });

  it("preserves replacement-generation runtime scheduled turns during restart cleanup", async () => {
    const removed: string[] = [];
    const scheduledIds = ["old-runtime-job", "new-runtime-job"];
    workflowMocks.cronAdd.mockImplementation(async () =>
      makeCronJob({ id: scheduledIds.shift() ?? "unexpected-job" }),
    );
    workflowMocks.cronRemove.mockImplementation(async (id: string) => {
      removed.push(id);
      return { ok: true, removed: true };
    });

    const previousFixture = createPluginRegistryFixture();
    previousFixture.registry.registry.plugins.push(
      createPluginRecord({
        id: WORKFLOW_PLUGIN_ID,
        name: "Workflow Plugin",
        origin: "bundled",
      }),
    );
    await scheduleWorkflowTurn({
      pluginName: "Workflow Plugin",
      ownerRegistry: previousFixture.registry.registry,
      schedule: {
        message: "old wake",
      },
    });

    const replacementFixture = createPluginRegistryFixture();
    replacementFixture.registry.registry.plugins.push(
      createPluginRecord({
        id: WORKFLOW_PLUGIN_ID,
        name: "Workflow Plugin",
        origin: "bundled",
      }),
    );
    await scheduleWorkflowTurn({
      pluginName: "Workflow Plugin",
      ownerRegistry: replacementFixture.registry.registry,
      schedule: {
        message: "new wake",
      },
    });

    const cleanupResult = await cleanupReplacedPluginHostRegistry({
      cfg: previousFixture.config,
      previousRegistry: previousFixture.registry.registry,
      nextRegistry: replacementFixture.registry.registry,
    });
    expect(cleanupResult.failures).toEqual([]);
    expect(removed).toEqual(["old-runtime-job"]);
    expect(listPluginSessionSchedulerJobs(WORKFLOW_PLUGIN_ID)).toEqual([
      {
        id: "new-runtime-job",
        pluginId: WORKFLOW_PLUGIN_ID,
        sessionKey: MAIN_SESSION_KEY,
        kind: "session-turn",
      },
    ]);
  });

  it("treats already-missing cron jobs as successful scheduled-turn cleanup", async () => {
    const removed: string[] = [];
    workflowMocks.cronAdd.mockResolvedValue(makeCronJob({ id: "already-missing-job" }));
    workflowMocks.cronRemove.mockImplementation(async (id: string) => {
      removed.push(id);
      return { ok: true, removed: false };
    });

    const alreadyMissingHandle = await scheduleWorkflowTurn();
    expectSessionTurnHandle(alreadyMissingHandle, "already-missing-job");

    await expect(
      cleanupPluginSessionSchedulerJobs({
        pluginId: WORKFLOW_PLUGIN_ID,
        reason: "disable",
      }),
    ).resolves.toEqual([]);
    expect(removed).toEqual(["already-missing-job"]);
    expect(listPluginSessionSchedulerJobs(WORKFLOW_PLUGIN_ID)).toEqual([]);
  });

  it("removes only matching plugin tag jobs in the requested session", async () => {
    const removed: string[] = [];
    const listQueries: unknown[] = [];
    workflowMocks.cronListPage.mockImplementation(async (body: unknown) => {
      listQueries.push((body as { query?: unknown }).query);
      return {
        jobs: [
          makeCronJob({
            id: "job-a",
            name: "plugin:workflow-plugin:tag:nudge:agent:main:main:1",
            sessionTarget: "session:agent:main:main",
          }),
          makeCronJob({
            id: "job-b",
            name: "plugin:workflow-plugin:tag:nudge:agent:main:main:2",
            sessionTarget: "session:agent:main:main",
          }),
          makeCronJob({
            id: "job-c",
            name: "plugin:other-plugin:tag:nudge:agent:main:main:1",
            sessionTarget: "session:agent:main:main",
          }),
          makeCronJob({
            id: "job-d",
            name: "plugin:workflow-plugin:tag:nudge:agent:other:main:1",
            sessionTarget: "session:agent:other:main",
          }),
        ],
        total: 4,
        offset: 0,
        limit: 200,
        hasMore: false,
        nextOffset: null,
      };
    });
    workflowMocks.cronRemove.mockImplementation(async (id: string) => {
      removed.push(id);
      return { ok: true, removed: true };
    });

    await expect(unscheduleWorkflowTurnsByTag()).resolves.toEqual({ removed: 2, failed: 0 });
    expect(listQueries).toEqual(["plugin:workflow-plugin:tag:nudge:agent:main:main:"]);
    expect(removed.toSorted()).toEqual(["job-a", "job-b"]);
  });

  it("prunes runtime scheduler records after tagged unschedule removes jobs", async () => {
    let addCount = 0;
    workflowMocks.cronAdd.mockImplementation(async () => {
      addCount += 1;
      return makeCronJob({ id: `job-${addCount}` });
    });
    workflowMocks.cronListPage.mockResolvedValue({
      jobs: [
        makeCronJob({
          id: "job-1",
          name: "plugin:workflow-plugin:tag:nudge:agent:main:main:first",
          sessionTarget: "session:agent:main:main",
        }),
        makeCronJob({
          id: "job-2",
          name: "plugin:workflow-plugin:tag:nudge:agent:main:main:second",
          sessionTarget: "session:agent:main:main",
        }),
      ],
      total: 2,
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
    });
    workflowMocks.cronRemove.mockImplementation(async (id: string) => {
      expect(["job-1", "job-2"]).toContain(id);
      return { ok: true, removed: true };
    });

    await scheduleWorkflowTurn({
      schedule: {
        message: "first",
        tag: "nudge",
        name: "first",
      },
    });
    await scheduleWorkflowTurn({
      schedule: {
        message: "second",
        tag: "nudge",
        name: "second",
      },
    });
    expect(listPluginSessionSchedulerJobs(WORKFLOW_PLUGIN_ID)).toHaveLength(2);

    await expect(unscheduleWorkflowTurnsByTag()).resolves.toEqual({ removed: 2, failed: 0 });
    expect(listPluginSessionSchedulerJobs(WORKFLOW_PLUGIN_ID)).toEqual([]);
  });

  it("counts cron.list and cron.remove failures when unscheduling by tag", async () => {
    workflowMocks.cronListPage.mockRejectedValueOnce(new Error("cron list unavailable"));
    await expect(unscheduleWorkflowTurnsByTag()).resolves.toEqual({ removed: 0, failed: 1 });

    workflowMocks.cronListPage.mockReset();
    workflowMocks.cronListPage.mockResolvedValue({
      jobs: [
        makeCronJob({
          id: "job-ok",
          name: "plugin:workflow-plugin:tag:nudge:agent:main:main:1",
          sessionTarget: "session:agent:main:main",
        }),
        makeCronJob({
          id: "job-fail",
          name: "plugin:workflow-plugin:tag:nudge:agent:main:main:2",
          sessionTarget: "session:agent:main:main",
        }),
      ],
      total: 2,
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
    });
    workflowMocks.cronRemove.mockImplementation(async (id: string) => {
      if (id === "job-fail") {
        throw new Error("remove failed");
      }
      return { ok: true, removed: true };
    });

    await expect(unscheduleWorkflowTurnsByTag()).resolves.toEqual({ removed: 1, failed: 1 });

    workflowMocks.cronListPage.mockReset();
    workflowMocks.cronListPage.mockResolvedValue({
      jobs: [
        makeCronJob({
          id: "job-missing",
          name: "plugin:workflow-plugin:tag:nudge:agent:main:main:1",
          sessionTarget: "session:agent:main:main",
        }),
      ],
      total: 1,
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
    });
    workflowMocks.cronRemove.mockImplementation(async (id: string) => {
      expect(id).toBe("job-missing");
      return { ok: true, removed: false };
    });

    await expect(unscheduleWorkflowTurnsByTag()).resolves.toEqual({ removed: 0, failed: 1 });
  });

  it("does not unschedule turns for non-bundled plugins or invalid tag requests", async () => {
    await expect(unscheduleWorkflowTurnsByTag(undefined, "workspace")).resolves.toEqual({
      removed: 0,
      failed: 0,
    });
    await expect(
      unscheduleWorkflowTurnsByTag({ sessionKey: MAIN_SESSION_KEY, tag: "   " }),
    ).resolves.toEqual({ removed: 0, failed: 0 });
    await expect(
      unscheduleWorkflowTurnsByTag({ sessionKey: MAIN_SESSION_KEY, tag: "nudge:followup" }),
    ).resolves.toEqual({ removed: 0, failed: 0 });
    expect(workflowMocks.cronListPage).not.toHaveBeenCalled();
    expect(workflowMocks.cronRemove).not.toHaveBeenCalled();
  });

  it("wires schedule and unschedule through the plugin API with stale-registry protection", async () => {
    workflowMocks.cronAdd.mockResolvedValue(makeCronJob({ id: "job-live" }));
    const { config, registry } = createPluginRegistryFixture({}, { hostServices: { cron } });
    let capturedApi: OpenClawPluginApi | undefined;
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "scheduler-plugin",
        name: "Scheduler Plugin",
        origin: "bundled",
      }),
      register(api) {
        capturedApi = api;
      },
    });
    setActivePluginRegistry(registry.registry);

    const liveHandle = await capturedApi?.session.workflow.scheduleSessionTurn({
      sessionKey: "agent:main:main",
      message: "wake",
      delayMs: 10,
    });
    expectSessionTurnHandle(liveHandle, "job-live", "scheduler-plugin");
    await expect(
      capturedApi?.session.workflow.unscheduleSessionTurnsByTag({
        sessionKey: "agent:main:main",
        tag: "nudge",
      }),
    ).resolves.toEqual({ removed: 0, failed: 0 });

    setActivePluginRegistry(createEmptyPluginRegistry());
    await expect(
      capturedApi?.session.workflow.scheduleSessionTurn({
        sessionKey: "agent:main:main",
        message: "wake",
        delayMs: 10,
      }),
    ).resolves.toBeUndefined();
    await expect(
      capturedApi?.session.workflow.unscheduleSessionTurnsByTag({
        sessionKey: "agent:main:main",
        tag: "nudge",
      }),
    ).resolves.toEqual({ removed: 0, failed: 0 });
  });

  it("resolves live cron service for captured plugin scheduled-turn APIs", async () => {
    const firstCron = createMockCronService();
    const secondCron = createMockCronService();
    const firstAdd = vi.fn(async () => makeCronJob({ id: "first-cron-job" }));
    const secondAdd = vi.fn(async () => makeCronJob({ id: "second-cron-job" }));
    const firstListPage = vi.fn(async () => {
      throw new Error("stale cron list used");
    });
    const firstRemove = vi.fn(async () => {
      throw new Error("stale cron remove used");
    });
    const secondListPage = vi.fn(async () => ({
      jobs: [
        makeCronJob({
          id: "second-cron-existing-job",
          name: "plugin:scheduler-plugin:tag:nudge:agent:main:main:1",
          sessionTarget: "session:agent:main:main",
        }),
      ],
      total: 1,
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
    }));
    const secondRemove = vi.fn(async () => ({ ok: true, removed: true }) as const);
    firstCron.add = firstAdd;
    firstCron.listPage = firstListPage;
    firstCron.remove = firstRemove;
    secondCron.add = secondAdd;
    secondCron.listPage = secondListPage;
    secondCron.remove = secondRemove;
    let liveCron = firstCron;
    const hostServices = {
      get cron() {
        return liveCron;
      },
    };
    const { config, registry } = createPluginRegistryFixture({}, { hostServices });
    let capturedApi: OpenClawPluginApi | undefined;
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "scheduler-plugin",
        name: "Scheduler Plugin",
        origin: "bundled",
      }),
      register(api) {
        capturedApi = api;
      },
    });
    setActivePluginRegistry(registry.registry);

    await expect(
      capturedApi?.session.workflow.scheduleSessionTurn({
        sessionKey: "agent:main:main",
        message: "wake",
        delayMs: 10,
      }),
    ).resolves.toEqual({
      id: "first-cron-job",
      pluginId: "scheduler-plugin",
      sessionKey: "agent:main:main",
      kind: "session-turn",
    });
    liveCron = secondCron;
    await expect(
      capturedApi?.session.workflow.scheduleSessionTurn({
        sessionKey: "agent:main:main",
        message: "wake again",
        delayMs: 10,
      }),
    ).resolves.toEqual({
      id: "second-cron-job",
      pluginId: "scheduler-plugin",
      sessionKey: "agent:main:main",
      kind: "session-turn",
    });
    await expect(
      capturedApi?.session.workflow.unscheduleSessionTurnsByTag({
        sessionKey: "agent:main:main",
        tag: "nudge",
      }),
    ).resolves.toEqual({ removed: 1, failed: 0 });

    expect(firstAdd).toHaveBeenCalledTimes(1);
    expect(secondAdd).toHaveBeenCalledTimes(1);
    expect(firstListPage).not.toHaveBeenCalled();
    expect(firstRemove).not.toHaveBeenCalled();
    expect(secondListPage).toHaveBeenCalledTimes(1);
    expect(secondRemove).toHaveBeenCalledWith("second-cron-existing-job");
  });

  it("blocks registration-time schedule and unschedule calls before activation", async () => {
    // Drain any cleanup microtasks queued by the previous test's
    // setActivePluginRegistry calls; setActivePluginRegistry schedules
    // cleanup via fire-and-forget dynamic imports that may resolve after
    // this test's mockReset.
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    const activeFixture = createPluginRegistryFixture();
    setActivePluginRegistry(activeFixture.registry.registry);

    const loadingFixture = createPluginRegistryFixture();
    const loadingApi = loadingFixture.registry.createApi(
      createPluginRecord({
        id: "preactivation-scheduler",
        name: "Preactivation Scheduler",
        origin: "bundled",
      }),
      { config: loadingFixture.config },
    );

    await expect(
      loadingApi.session.workflow.scheduleSessionTurn({
        sessionKey: "agent:main:main",
        message: "wake",
        delayMs: 10,
      }),
    ).resolves.toBeUndefined();
    await expect(
      loadingApi.session.workflow.unscheduleSessionTurnsByTag({
        sessionKey: "agent:main:main",
        tag: "nudge",
      }),
    ).resolves.toEqual({ removed: 0, failed: 0 });
    expect(workflowMocks.cronAdd).not.toHaveBeenCalled();
    expect(workflowMocks.cronListPage).not.toHaveBeenCalled();
    expect(workflowMocks.cronRemove).not.toHaveBeenCalled();
  });
});
