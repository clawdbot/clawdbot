import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { CronRunLogEntry } from "../../cron/run-log-types.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { cronStoreKey } from "../../cron/store/key.js";
import {
  cronRunLogEntryToTaskDetail,
  cronRunStatusToTaskStatus,
} from "../../cron/task-run-detail.js";
import { saveTaskRegistryStateToSqlite } from "../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { cronHandlers } from "./cron.js";
import type { GatewayClient, RespondFn } from "./types.js";

async function withCronHistory(
  run: (fixture: {
    jobId: string;
    foreignJobId: string;
    cron: CronService;
    query: (
      params: Record<string, unknown>,
      client?: GatewayClient,
    ) => Promise<ReturnType<typeof vi.fn<RespondFn>>>;
    viewer: GatewayClient;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {
      ...rolePolicyConfig(),
      agents: { entries: { main: { workspace: state.workspaceDir } } },
    };
    await state.writeConfig(cfg);
    const owner = roleClient("none", "history-owner");
    const foreign = roleClient("none", "history-foreign");
    const viewer = roleClient("view", "history-viewer");
    const ownKey = "agent:main:history-own";
    const foreignKey = "agent:main:history-foreign";
    for (const [sessionKey, client] of [
      [ownKey, owner],
      [foreignKey, foreign],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: sessionKey,
          updatedAt: Date.now(),
          createdActor: {
            type: "human",
            source: "profile",
            id: expectDefined(client.authenticatedUserProfile, "fixture profile").profileId,
          },
        },
      );
    }
    const storePath = state.path("cron", "jobs.json");
    const cron = new CronService({
      storePath,
      defaultAgentId: "main",
      cronEnabled: false,
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    try {
      const jobs = [];
      for (const sessionKey of [ownKey, foreignKey]) {
        const result = await cron.add({
          name: sessionKey,
          agentId: "main",
          owner: { agentId: "main", sessionKey },
          enabled: false,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "fixture" },
          delivery: { mode: "none" },
        });
        jobs.push("job" in result ? result.job : result);
      }
      const jobId = expectDefined(jobs[0], "own job").id;
      const foreignJobId = expectDefined(jobs[1], "foreign job").id;
      const rows: Array<Pick<CronRunLogEntry, "sessionKey" | "status" | "summary" | "jobId">> = [
        { jobId, sessionKey: foreignKey, status: "error", summary: "needle hidden" },
        { jobId, sessionKey: ownKey, status: "error", summary: "needle first" },
        { jobId, sessionKey: foreignKey, status: "ok", summary: "other hidden" },
        { jobId, status: "error", summary: "needle second" },
        { jobId, sessionKey: ownKey, status: "ok", summary: "other third" },
        { jobId: foreignJobId, sessionKey: ownKey, status: "error", summary: "needle foreign job" },
      ];
      const now = Date.now();
      const tasks = rows.map((row, index): TaskRecord => {
        const entry: CronRunLogEntry = {
          ...row,
          action: "finished",
          ts: now + index,
          runId: `history-run-${index}`,
          deliveryStatus: row.status === "error" ? "not-delivered" : "delivered",
        };
        return {
          taskId: `history-task-${index}`,
          runtime: "cron",
          sourceId: entry.jobId,
          requesterSessionKey: "",
          ownerKey: "",
          scopeKind: "system",
          childSessionKey: entry.sessionKey,
          agentId: "main",
          task: "history fixture",
          status: cronRunStatusToTaskStatus(entry),
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          createdAt: entry.ts,
          endedAt: entry.ts,
          detail: cronRunLogEntryToTaskDetail(entry, { storeKey: cronStoreKey(storePath) }),
        };
      });
      saveTaskRegistryStateToSqlite({
        tasks: new Map(tasks.map((task) => [task.taskId, task])),
        deliveryStates: new Map(),
      });
      const context = createDirectChatContext({
        cron,
        cronStorePath: storePath,
        getRuntimeConfig: () => cfg,
      });
      const query = async (params: Record<string, unknown>, client = owner) => {
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          cronHandlers["cron.runs"],
          "cron.runs handler",
        )({
          req: { type: "req", id: "history-request", method: "cron.runs", params },
          params,
          client,
          respond,
          context,
          isWebchatConnect: () => false,
        });
        return respond;
      };
      await run({ jobId, foreignJobId, cron, query, viewer });
    } finally {
      cron.stop();
    }
  });
}

describe("cron.runs session visibility", () => {
  it.each(["job", "all"] as const)(
    "paginates visible %s history before counting and slicing",
    async (scope) => {
      await withCronHistory(async ({ jobId, query }) => {
        const selector = scope === "job" ? { id: jobId } : { scope };
        for (const [offset, summary] of [
          "needle first",
          "needle second",
          "other third",
        ].entries()) {
          const respond = await query({
            ...selector,
            agentId: "MAIN",
            limit: 1,
            offset,
            sortDir: "asc",
          });
          expect(respond).toHaveBeenCalledWith(
            true,
            {
              entries: [expect.objectContaining({ summary })],
              total: 3,
              offset,
              limit: 1,
              hasMore: offset < 2,
              nextOffset: offset < 2 ? offset + 1 : null,
            },
            undefined,
          );
        }
        expect(await query({ ...selector, offset: 99, limit: 1 })).toHaveBeenCalledWith(
          true,
          {
            entries: [],
            total: 3,
            offset: 3,
            limit: 1,
            hasMore: false,
            nextOffset: null,
          },
          undefined,
        );
      });
    },
  );

  it.each(["job", "all"] as const)("combines %s visibility with history filters", async (scope) => {
    await withCronHistory(async ({ jobId, query }) => {
      const respond = await query({
        ...(scope === "job" ? { id: jobId } : { scope }),
        agentId: "MAIN",
        statuses: ["error"],
        deliveryStatuses: ["not-delivered"],
        query: "needle",
        sortDir: "asc",
        offset: 1,
        limit: 1,
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        {
          entries: [expect.objectContaining({ summary: "needle second" })],
          total: 2,
          offset: 1,
          limit: 1,
          hasMore: false,
          nextOffset: null,
        },
        undefined,
      );
    });
  });

  it("keeps foreign jobs hidden and retained deleted-job history available to viewers", async () => {
    await withCronHistory(async ({ jobId, foreignJobId, cron, query, viewer }) => {
      expect(await query({ id: foreignJobId })).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ details: { code: "CRON_JOB_NOT_FOUND", jobId: foreignJobId } }),
      );
      await cron.remove(jobId);
      expect(await query({ id: jobId })).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ details: { code: "CRON_JOB_NOT_FOUND", jobId } }),
      );
      expect(
        await query({ id: jobId, limit: 1, runId: "history-run-1" }, viewer),
      ).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          entries: [expect.objectContaining({ summary: "needle first" })],
          total: 1,
        }),
        undefined,
      );
    });
  });
});
