import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger, writeCronStoreSnapshot } from "../../cron/service.test-harness.js";
import * as sqliteRuntime from "../../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import * as sessionCreator from "../session-creator.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { cronHandlers } from "./cron.js";
import type { RespondFn } from "./types.js";

async function withCronList(
  run: (fixture: {
    cron: CronService;
    query: (compact: boolean) => Promise<ReturnType<typeof vi.fn<RespondFn>>>;
    databasePath: string;
    ownerKey: string;
    foreignProfileId: string;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {
      ...rolePolicyConfig(),
      agents: { entries: { main: { workspace: state.workspaceDir } } },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg, cfg);
    const client = roleClient("none", "cron-list-owner");
    const foreign = roleClient("none", "cron-list-foreign");
    const ownerKey = "agent:main:cron-list-owner";
    const foreignKey = "agent:main:cron-list-foreign";
    const foreignProfileId = expectDefined(
      foreign.authenticatedUserProfile,
      "foreign profile",
    ).profileId;
    for (const [sessionKey, profile] of [
      [ownerKey, expectDefined(client.authenticatedUserProfile, "owner profile")],
      [foreignKey, expectDefined(foreign.authenticatedUserProfile, "foreign profile")],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        {
          sessionId: sessionKey,
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: profile.profileId },
        },
      );
    }
    for (let index = 0; index < 8; index++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:unrelated-${index}` },
        { sessionId: `cron-unrelated-metadata-${index}`, updatedAt: 1 },
      );
    }
    const storePath = state.path("cron", "jobs.json");
    const jobs = Array.from({ length: 201 }, (_, index) =>
      makeCronJob({
        id: `job-${String(index).padStart(3, "0")}`,
        name: `job-${String(index).padStart(3, "0")}`,
        enabled: false,
        agentId: "main",
        owner: { agentId: "main", sessionKey: index === 200 ? foreignKey : ownerKey },
        delivery: { mode: "none" },
      }),
    );
    await writeCronStoreSnapshot({ storePath, jobs });
    const cron = new CronService({
      storePath,
      defaultAgentId: "main",
      cronEnabled: true,
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    const context = createDirectChatContext({ cron, getRuntimeConfig: () => cfg });
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    try {
      await cron.start();
      closeOpenClawAgentDatabasesForTest();
      await run({
        cron,
        databasePath,
        ownerKey,
        foreignProfileId,
        query: async (compact) => {
          const params = {
            includeDisabled: true,
            includeDeliveryPreviews: false,
            compact,
            limit: 200,
            sortBy: "name",
            sortDir: "asc",
          };
          const respond = vi.fn<RespondFn>();
          await expectDefined(
            cronHandlers["cron.list"],
            "cron.list handler",
          )({
            req: { type: "req", id: "list-request", method: "cron.list", params },
            params,
            client,
            respond,
            context,
            isWebchatConnect: () => false,
          });
          return respond;
        },
      });
    } finally {
      cron.stop();
    }
  });
}

describe("cron.list session visibility", () => {
  it.each([false, true])(
    "bounds cold validation to each source page (compact=%s)",
    async (compact) => {
      await withCronList(async ({ cron, query, databasePath }) => {
        let unrelatedParses = 0;
        const parse = JSON.parse;
        const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((value, reviver) => {
          if (value.includes("cron-unrelated-metadata-")) {
            unrelatedParses++;
          }
          return parse(value, reviver);
        });
        const readers: DatabaseSync[] = [];
        const open = sqliteRuntime.openNodeSqliteDatabase;
        const openSpy = vi
          .spyOn(sqliteRuntime, "openNodeSqliteDatabase")
          .mockImplementation((location, options) => {
            const db = open(location, options);
            if (location === databasePath && options?.readOnly) {
              readers.push(db);
            }
            return db;
          });
        const listPage = cron.listPage.bind(cron);
        const pageSpy = vi.spyOn(cron, "listPage").mockImplementation(async (options) => {
          expect(readers.every((db) => !db.isOpen)).toBe(true);
          return listPage(options);
        });
        try {
          const respond = await query(compact);
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              total: 200,
              jobs: Array.from({ length: 200 }, (_, index) =>
                expect.objectContaining({ id: `job-${String(index).padStart(3, "0")}` }),
              ),
              hasMore: false,
              nextOffset: null,
            }),
            undefined,
          );
          expect(readers.every((db) => !db.isOpen)).toBe(true);
          expect(getOpenClawAgentDatabaseIfOpen({ agentId: "main" })).toBeUndefined();
          // Two source pages may validate the cold store once each, not once per job.
          expect(unrelatedParses).toBeLessThanOrEqual(8 * 2);
        } finally {
          pageSpy.mockRestore();
          openSpy.mockRestore();
          parseSpy.mockRestore();
        }
      });
    },
  );

  it("rereads repeated session targets after the preceding job's creator check", async () => {
    await withCronList(async ({ query, databasePath, foreignProfileId, ownerKey }) => {
      const writer = new (sqliteRuntime.requireNodeSqlite().DatabaseSync)(databasePath);
      const matchesCreator = sessionCreator.isSessionCreatorProfile;
      let changed = false;
      const creatorSpy = vi
        .spyOn(sessionCreator, "isSessionCreatorProfile")
        .mockImplementation((actor, profileId) => {
          const matches = matchesCreator(actor, profileId);
          if (matches && !changed) {
            changed = true;
            writer
              .prepare(
                "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.createdActor.id', ?) WHERE session_key = ?",
              )
              .run(foreignProfileId, ownerKey);
          }
          return matches;
        });
      try {
        const respond = await query(true);
        expect(changed).toBe(true);
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            total: 1,
            jobs: [expect.objectContaining({ id: "job-000" })],
          }),
          undefined,
        );
      } finally {
        creatorSpy.mockRestore();
        writer.close();
      }
    });
  });
});
