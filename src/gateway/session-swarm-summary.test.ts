import { afterEach, describe, expect, it } from "vitest";
import { clearSubagentRunsReadCacheForTest } from "../agents/subagents/registry/subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../agents/tools/sessions-resolution.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  buildGatewaySessionSnapshot,
  buildGatewaySessionEventFields,
} from "./session-event-payload.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import { buildSessionSwarmSummary } from "./session-swarm-summary.js";

const parent = "agent:main:dashboard:research";
const groupId = `swarm:${parent}:turn`;
const cfg = { agents: { entries: { main: {}, other: {} } } };

function collector(index: number, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: `run-${index}`,
    childSessionKey: `agent:main:subagent:${index}`,
    requesterSessionKey: parent,
    requesterAgentId: "main",
    requesterDisplayKey: parent,
    controllerSessionKey: parent,
    swarmRequesterSessionKey: parent,
    task: "Private child task text must not reach the summary",
    cleanup: "delete",
    collect: true,
    groupId,
    createdAt: 100 + index,
    execution: { status: "terminal", startedAt: 200, endedAt: 300 },
    completion: { required: false, resultText: "Private child result" },
    delivery: { status: "not_required" },
    collectorCompletion: { status: index < 25 ? "done" : "failed" },
    ...overrides,
  };
}

async function withCollectors(runs: SubagentRunRecord[], run: () => Promise<void>) {
  await withStateDirEnv("session-swarm-summary-", async () => {
    await withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
      saveSubagentRegistryToSqlite(new Map(runs.map((entry) => [entry.runId, entry])));
      await run();
    });
  });
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  clearSubagentRunsReadCacheForTest();
});

describe("parent Swarm outcome projection", () => {
  it("counts every retained collector after child sessions are deleted", async () => {
    await withCollectors(
      Array.from({ length: 30 }, (_, index) => collector(index)),
      async () => {
        const result = await listSessionFixture({
          cfg,
          storePath: "",
          store: { [parent]: { sessionId: "parent", updatedAt: 400 } },
          opts: {},
        });
        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]).toMatchObject({
          swarm: {
            groups: [{ groupId, createdAt: 100, queued: 0, running: 0, done: 25, failed: 5 }],
            otherActiveGroups: 0,
          },
        });
        expect(buildGatewaySessionEventFields({ sessionRow: result.sessions[0]! })).toMatchObject({
          swarm: { groups: [{ done: 25, failed: 5 }] },
        });
        expect(JSON.stringify(result)).not.toContain("Private child");
      },
    );
  });

  it("does not expose a hidden parent's summary or borrow another parent's collectors", async () => {
    await withCollectors([collector(0)], async () => {
      const store = {
        [parent]: { sessionId: "parent", updatedAt: 400 },
        "agent:main:other": { sessionId: "other", updatedAt: 400 },
      };
      const result = await listSessionFixture({
        cfg,
        storePath: "",
        store,
        opts: {},
        entryFilter: (key) => key !== parent,
      });
      expect(result.sessions).toHaveLength(1);
      expect(JSON.stringify(result.sessions[0])).not.toContain('"swarm":');
    });
  });
  it("keeps list payloads compact and selected-parent details bounded without losing totals", () => {
    const runs = Array.from({ length: 300 }, (_, index) => collector(index));
    runs.push(
      collector(300, {
        collectorCompletion: undefined,
        execution: { status: "running", startedAt: 300 },
      }),
    );
    const summary = buildSessionSwarmSummary(runs, parent, "main");
    expect(summary?.groups[0]).toMatchObject({ running: 1, done: 25, failed: 275 });
    expect(summary?.groups[0]).not.toHaveProperty("children");
    const detailed = buildSessionSwarmSummary(runs, parent, "main", { includeChildren: true });
    expect(detailed?.groups[0]?.children).toHaveLength(64);
    expect(detailed?.groups[0]?.children?.[0]).toEqual({
      sessionKey: "agent:main:subagent:300",
      status: "running",
    });
    expect(
      buildGatewaySessionEventFields({
        sessionRow: { key: parent, kind: "direct", updatedAt: 0, swarm: detailed },
      }).swarm,
    ).toEqual(summary);
  });

  it("separates global owners even when they reuse a custom group id", () => {
    const runs = [
      collector(0, {
        requesterSessionKey: "global",
        swarmRequesterSessionKey: "global",
        groupId: "review",
      }),
      collector(25, {
        requesterSessionKey: "global",
        swarmRequesterSessionKey: "global",
        requesterAgentId: "other",
        groupId: "review",
      }),
    ];
    expect(buildSessionSwarmSummary(runs, "global", "main")?.groups).toMatchObject([
      { groupId: "review", done: 1, failed: 0 },
    ]);
    expect(
      buildSessionSwarmSummary(runs, "global", "other", { includeChildren: true })?.groups,
    ).toMatchObject([
      {
        groupId: "review",
        done: 0,
        failed: 1,
        children: [{ sessionKey: "agent:main:subagent:25", status: "failed" }],
      },
    ]);
  });

  it.each(["main", "workspace", "global"])(
    "joins admitted global-scope %s collectors to their owner row",
    async (suffix) => {
      const globalConfig = { ...cfg, session: { scope: "global" as const, mainKey: "workspace" } };
      const admitted = resolveSessionStoreIdentity({
        cfg: globalConfig,
        sessionKey: `agent:other:${suffix}`,
      });
      const { alias, mainKey } = resolveMainSessionAlias(globalConfig);
      const requesterKey = resolveInternalSessionKey({
        key: admitted.canonicalKey,
        alias,
        mainKey,
      });
      expect(requesterKey).toBe(suffix === "global" ? "agent:other:global" : "global");
      await withCollectors(
        [
          collector(0, {
            swarmRequesterSessionKey: requesterKey,
            requesterSessionKey: requesterKey,
            requesterAgentId: admitted.agentId,
          }),
        ],
        async () => {
          const result = await listSessionFixture({
            cfg: globalConfig,
            storePath: "",
            store: { [admitted.canonicalKey]: { sessionId: "global-owner", updatedAt: 400 } },
            opts: { agentId: admitted.agentId, includeGlobal: true },
          });
          expect(result.sessions).toMatchObject([
            { key: requesterKey, agentId: "other", swarm: { groups: [{ done: 1 }] } },
          ]);
        },
      );
    },
  );

  it("bounds active groups and keeps only the latest completed group", () => {
    const runs = Array.from({ length: 8 }, (_, index) =>
      collector(index, {
        groupId: `group-${index}`,
        ...(index < 6
          ? { collectorCompletion: undefined, execution: { status: "queued" as const } }
          : {}),
      }),
    );
    const summary = buildSessionSwarmSummary(runs, parent, "main");
    expect(summary?.groups.map((group) => group.groupId)).toEqual([
      "group-5",
      "group-4",
      "group-3",
      "group-2",
      "group-7",
    ]);
    expect(summary?.otherActiveGroups).toBe(2);
  });
  it("does not infer missing collector ownership from completion routing", () => {
    expect(
      buildSessionSwarmSummary(
        [collector(0, { swarmRequesterSessionKey: undefined })],
        parent,
        "main",
      ),
    ).toBeUndefined();
    expect(
      buildSessionSwarmSummary([collector(0, { requesterAgentId: undefined })], parent, "main"),
    ).toBeUndefined();
  });

  it.each(["global", "unknown"])(
    "clears computed counts but omits uncomputed and unscoped %s events",
    (key) => {
      const swarm = buildSessionSwarmSummary([collector(0)], parent, "main", {
        includeChildren: true,
      });
      expect(
        buildGatewaySessionEventFields({
          sessionRow: { key: parent, kind: "direct", updatedAt: 0 },
        }),
      ).not.toHaveProperty("swarm");
      expect(
        buildGatewaySessionEventFields({
          sessionRow: { key: parent, kind: "direct", updatedAt: 0, swarm: undefined },
        }),
      ).toHaveProperty("swarm", null);
      expect(
        buildGatewaySessionEventFields({
          sessionRow: { key, kind: "global", updatedAt: 0, swarm },
          agentId: "main",
        }),
      ).toMatchObject({ swarm: { groups: [{ done: 1, failed: 0 }] } });
      expect(
        buildGatewaySessionEventFields({
          sessionRow: { key, kind: "global", updatedAt: 0, swarm },
        }),
      ).not.toHaveProperty("swarm");
      const snapshot = buildGatewaySessionSnapshot({
        sessionRow: { key, kind: "global", updatedAt: 0, swarm },
        includeSession: true,
      });
      expect(snapshot).not.toHaveProperty("swarm");
      expect(snapshot.session).not.toHaveProperty("swarm");
    },
  );
});
