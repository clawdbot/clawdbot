import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { setCanonicalSqliteSessionMainKey } from "../../config/sessions/session-canonical-key.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { deleteTaskRecordById } from "../../tasks/runtime-internal.js";
import { reloadTaskRegistryFromStore } from "../../tasks/task-registry.js";
import { saveTaskRegistryStateToSqlite } from "../../tasks/task-registry.store.sqlite.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import { rolePolicyConfig } from "../session-sharing.test-utils.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import {
  captureRespond,
  createSnapshotTask,
  identifiedClient,
  runTaskHandler,
} from "./tasks.test-helpers.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  resetTaskRegistryForTests({ persist: false });
});
afterEach(async () => {
  resetTaskRegistryForTests({ persist: false });
  await state.cleanup();
});

describe("task page access snapshots", () => {
  it.each(["canonical", "main alias", "distinct requesters", "warm"] as const)(
    "bounds session lookup work across a yielded task page using %s keys",
    async (mode) => {
      const sessionKey = "agent:main:cold-requester";
      const warm = mode === "warm";
      const requesterKeys =
        mode === "distinct requesters"
          ? Array.from({ length: 65 }, (_, index) => `agent:main:requester-${index}`)
          : [sessionKey];
      const profileId = ensureProfileForEmail("cold-viewer@example.test").id;
      const config = rolePolicyConfig();
      if (mode === "main alias") {
        config.session = { mainKey: "cold-requester" };
        setCanonicalSqliteSessionMainKey(
          openOpenClawAgentDatabase({ agentId: "main" }),
          "cold-requester",
        );
      }
      for (const requesterKey of requesterKeys) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: requesterKey },
          { sessionId: `session-${requesterKey}`, updatedAt: 1, visibility: "shared" },
        );
      }
      const unrelatedCount = 24;
      for (let index = 0; index < unrelatedCount; index += 1) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:cold-unrelated-${index}` },
          { sessionId: `cold-unrelated-payload-${index}`, updatedAt: 1 },
        );
      }
      const tasks = Array.from({ length: 65 }, (_, index) =>
        createSnapshotTask({
          taskId: `cold-task-${index}`,
          requesterSessionKey:
            mode === "main alias" ? "main" : (requesterKeys[index] ?? sessionKey),
          requesterAgentId: "main",
          ownerKey: sessionKey,
          lastEventAt: 2_000 + index,
        }),
      );
      saveTaskRegistryStateToSqlite({
        tasks: new Map(tasks.map((task) => [task.taskId, task])),
        deliveryStates: new Map(),
      });
      reloadTaskRegistryFromStore();
      if (!warm) {
        closeOpenClawAgentDatabasesForTest();
      }
      const expectedHandles = listOpenClawAgentDatabasesForTest().length;
      expect(expectedHandles > 0).toBe(warm);
      let materializedUnrelated = 0;
      const materialize = Object.fromEntries;
      const materializeSpy = vi.spyOn(Object, "fromEntries").mockImplementation((entries) => {
        const result = materialize(entries);
        for (const entry of Object.values(result)) {
          if (
            entry &&
            typeof entry === "object" &&
            "sessionId" in entry &&
            typeof entry.sessionId === "string" &&
            entry.sessionId.startsWith("cold-unrelated-payload-")
          ) {
            materializedUnrelated += 1;
          }
        }
        return result;
      });
      let unrelatedParses = 0;
      const parse = JSON.parse;
      const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((value, reviver) => {
        if (value.includes("cold-unrelated-payload-")) {
          unrelatedParses += 1;
        }
        return parse(value, reviver);
      });
      const yielded = new Promise<{ parses: number; handles: number }>((resolve) => {
        setImmediate(() =>
          resolve({
            parses: unrelatedParses,
            handles: listOpenClawAgentDatabasesForTest().length,
          }),
        );
      });
      try {
        const { calls, payload } = await runTaskHandler(
          "tasks.list",
          { limit: 100 },
          config,
          identifiedClient(["operator.read"], profileId),
        );
        expect(calls[0]?.[0]).toBe(true);
        expect(payload?.tasks?.map((task) => task.id)).toEqual(
          tasks.toReversed().map((task) => task.taskId),
        );
        const slice = await yielded;
        expect(slice.handles).toBe(expectedHandles);
        if (!warm) {
          expect(slice.parses).toBeGreaterThan(0);
        }
        expect(listOpenClawAgentDatabasesForTest()).toHaveLength(expectedHandles);
        expect(materializedUnrelated).toBe(0);
        // Three synchronous slices plus fresh final authorization may each validate one cold store.
        expect(unrelatedParses).toBeLessThanOrEqual(unrelatedCount * 4);
      } finally {
        parseSpy.mockRestore();
        materializeSpy.mockRestore();
        await yielded;
      }
    },
  );

  it.each([
    "unpublished revocation",
    "published grant",
    "unpublished grant",
    "unpublished creation",
    "registry restart grant",
  ] as const)("rereads task access after a yielded %s", async (change) => {
    const config = rolePolicyConfig();
    const profileId = ensureProfileForEmail("task-viewer@example.test").id;
    const changingKey = "agent:main:changing-task-access";
    const stableKey = "agent:main:stable-task-access";
    const published = change === "published grant";
    const grant = change !== "unpublished revocation";
    const registryRestart = change === "registry restart grant";
    const changingIndex = !published && grant && !registryRestart ? 64 : 0;
    const entry = {
      sessionId: "changing-task-access",
      updatedAt: 1,
      visibility: grant ? ("draft" as const) : ("shared" as const),
    };
    if (change !== "unpublished creation") {
      await upsertSessionEntryCore({ agentId: "main", sessionKey: changingKey }, entry);
    }
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: stableKey },
      { sessionId: "stable-task-access", updatedAt: 1, visibility: "shared" },
    );
    const tasks = Array.from({ length: 65 }, (_, index) =>
      createSnapshotTask({
        taskId: `access-task-${index}`,
        requesterSessionKey: index === changingIndex ? changingKey : stableKey,
        requesterAgentId: "main",
        ownerKey: index === changingIndex ? changingKey : stableKey,
        lastEventAt: index === changingIndex ? 10_000 : 2_000 + index,
      }),
    );
    saveTaskRegistryStateToSqlite({
      tasks: new Map(tasks.map((task) => [task.taskId, task])),
      deliveryStates: new Map(),
    });
    reloadTaskRegistryFromStore();
    const context = {
      getRuntimeConfig: () => config,
      broadcast: () => {},
      getSessionEventSubscriberConnIds: () => new Set<string>(),
    };
    const accessRevision = readGatewayAccessRevision();
    // Exercise both an already-selected requester and one not yet visited when the scan yields.
    const mutation = new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        void (async () => {
          if (published) {
            const { calls, respond } = captureRespond();
            await expectDefined(
              sessionSharingHandlers["session.visibility.set"],
              "session.visibility.set handler",
            )({
              params: { sessionKey: changingKey, agentId: "main", visibility: "shared" },
              client: identifiedClient(["operator.admin"], profileId),
              context,
              respond,
            } as never);
            expect(calls[0]?.[0]).toBe(true);
            expect(readGatewayAccessRevision()).toBeGreaterThan(accessRevision);
          } else {
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey: changingKey },
              { ...entry, visibility: grant ? "shared" : "draft", updatedAt: 2 },
            );
            expect(readGatewayAccessRevision()).toBe(accessRevision);
            if (registryRestart) {
              expect(deleteTaskRecordById("access-task-63")).toBe(true);
            }
          }
        })().then(resolve, reject);
      });
    });
    const [{ calls, payload }] = await Promise.all([
      runTaskHandler(
        "tasks.list",
        { limit: 1 },
        config,
        identifiedClient(["operator.read"], profileId),
        context as never,
      ),
      mutation,
    ]);
    expect(calls[0]?.[0]).toBe(true);
    expect(payload?.tasks?.map((task) => task.id)).toEqual([
      grant ? `access-task-${changingIndex}` : "access-task-64",
    ]);
  });
});
