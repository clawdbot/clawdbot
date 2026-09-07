import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { SessionCapability, SessionListOptions } from "./index.ts";
import {
  hydrateSwarmSessionRows,
  isSwarmEnabledInConfig,
  mergeSwarmSessionRows,
  SwarmRosterHydrator,
} from "./swarm-roster.ts";

function row(index: number): GatewaySessionRow {
  return {
    key: `agent:worker:subagent:${index}`,
    kind: "direct",
    updatedAt: index,
    spawnedBy: "agent:main:parent",
    swarmGroupId: "swarm:agent:main:parent:run-1",
  };
}

function result(rows: GatewaySessionRow[], offset: number, totalCount: number): SessionsListResult {
  const nextOffset = offset + rows.length;
  return {
    ts: Date.now(),
    path: "state/openclaw.sqlite",
    count: rows.length,
    totalCount,
    limitApplied: 10_000,
    offset,
    nextOffset: nextOffset < totalCount ? nextOffset : null,
    hasMore: nextOffset < totalCount,
    defaults: {} as SessionsListResult["defaults"],
    sessions: rows,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isSwarmEnabledInConfig", () => {
  it.each([
    { label: "unloaded config", config: undefined },
    { label: "omitted tools", config: {} },
    { label: "omitted swarm", config: { tools: {} } },
    { label: "empty swarm", config: { tools: { swarm: {} } } },
    { label: "limits-only swarm", config: { tools: { swarm: { maxConcurrent: 3 } } } },
    {
      label: "limits-only agent swarm",
      config: { agents: { entries: { worker: { tools: { swarm: { maxConcurrent: 3 } } } } } },
    },
  ])("defaults to enabled with $label", ({ config }) => {
    expect(isSwarmEnabledInConfig(config, "worker")).toBe(true);
  });

  it.each([
    { globalSwarm: false, agentSwarm: {}, expected: false },
    { globalSwarm: { enabled: false }, agentSwarm: { maxConcurrent: 3 }, expected: false },
    { globalSwarm: true, agentSwarm: { enabled: false }, expected: false },
    { globalSwarm: { enabled: true }, agentSwarm: false, expected: false },
    { globalSwarm: false, agentSwarm: { enabled: true }, expected: true },
    { globalSwarm: { enabled: false }, agentSwarm: true, expected: true },
    { globalSwarm: undefined, agentSwarm: false, expected: false },
    { globalSwarm: undefined, agentSwarm: { enabled: false }, expected: false },
  ])("resolves global $globalSwarm and agent $agentSwarm as $expected", (testCase) => {
    expect(
      isSwarmEnabledInConfig(
        {
          tools: { swarm: testCase.globalSwarm },
          agents: { entries: { WORKER: { tools: { swarm: testCase.agentSwarm } } } },
        },
        "worker",
      ),
    ).toBe(testCase.expected);
  });

  it("accepts both the boolean and object configuration forms", () => {
    expect(isSwarmEnabledInConfig({ tools: { swarm: true } })).toBe(true);
    expect(isSwarmEnabledInConfig({ tools: { swarm: { enabled: true } } })).toBe(true);
    expect(isSwarmEnabledInConfig({ tools: { swarm: false } })).toBe(false);
    expect(isSwarmEnabledInConfig({ tools: { swarm: { enabled: false } } })).toBe(false);
    expect(
      isSwarmEnabledInConfig(
        {
          tools: { swarm: false },
          agents: { entries: { WORKER: { tools: { swarm: true } } } },
        },
        "worker",
      ),
    ).toBe(true);
    expect(
      isSwarmEnabledInConfig(
        {
          tools: { swarm: true },
          agents: { entries: { worker: { tools: { swarm: false } } } },
        },
        "worker",
      ),
    ).toBe(false);
    expect(
      isSwarmEnabledInConfig(
        {
          tools: { swarm: false },
          agents: { entries: [{ id: "worker", tools: { swarm: true } }] },
        },
        "worker",
      ),
    ).toBe(false);
  });
});

describe("SwarmRosterHydrator", () => {
  it("clears rows when the gateway source epoch changes", () => {
    vi.useFakeTimers();
    const onRows = vi.fn();
    const hydrator = new SwarmRosterHydrator();
    const sessions = {
      canonicalListRevision: 0,
      list: vi.fn(async () => result([row(0)], 0, 1)),
    } as unknown as SessionCapability;

    hydrator.update({
      sessions,
      readParent: async () => ({ key: "agent:main:parent", kind: "direct" as const }),
      parentKey: "agent:main:parent",
      sourceEpoch: 1,
      currentRows: () => [row(0)],
      onRows,
    });
    expect(hydrator.rows).toHaveLength(1);

    hydrator.update({
      sessions,
      readParent: async () => ({ key: "agent:main:parent", kind: "direct" as const }),
      parentKey: "agent:main:parent",
      sourceEpoch: 2,
      currentRows: () => [],
      onRows,
    });

    expect(hydrator.rows).toEqual([]);
    expect(onRows).toHaveBeenLastCalledWith([]);
    hydrator.dispose();
  });

  it("keeps a freshly fetched tie winner over an unchanged current page", async () => {
    vi.useFakeTimers();
    const running = { ...row(0), status: "running" as const, updatedAt: 5 };
    const done = { ...row(0), status: "done" as const, updatedAt: 5 };
    let currentRows: GatewaySessionRow[] = [running];
    const hydrator = new SwarmRosterHydrator();
    const sessions = {
      canonicalListRevision: 0,
      list: vi.fn(async () => result([done], 0, 1)),
    } as unknown as SessionCapability;

    const params = {
      sessions,
      readParent: async () => ({ key: "agent:main:parent", kind: "direct" as const }),
      parentKey: "agent:main:parent",
      sourceEpoch: 1,
      currentRows: () => currentRows,
      onRows: () => undefined,
    };
    hydrator.update(params);
    await vi.runAllTimersAsync();

    expect(hydrator.rows.filter((entry) => entry.key !== "agent:main:parent")).toEqual([
      expect.objectContaining({ status: "done" }),
    ]);
    hydrator.update(params);
    expect(hydrator.rows.filter((entry) => entry.key !== "agent:main:parent")).toEqual([
      expect.objectContaining({ status: "done" }),
    ]);
    currentRows = [{ ...running, status: "failed" }];
    hydrator.update(params);
    expect(hydrator.rows.filter((entry) => entry.key !== "agent:main:parent")).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);
    hydrator.dispose();
  });

  it("keeps retrying at a bounded cadence after three transient failures", async () => {
    vi.useFakeTimers();
    const onRows = vi.fn();
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(result([row(0)], 0, 1));
    const hydrator = new SwarmRosterHydrator();
    const sessions = { canonicalListRevision: 0, list } as unknown as SessionCapability;

    hydrator.update({
      sessions,
      readParent: async () => ({ key: "agent:main:parent", kind: "direct" as const }),
      parentKey: "agent:main:parent",
      sourceEpoch: 1,
      currentRows: () => [],
      onRows,
    });
    await vi.runAllTimersAsync();

    expect(list).toHaveBeenCalledTimes(4);
    expect(hydrator.rows.filter((entry) => entry.key !== "agent:main:parent")).toEqual([
      expect.objectContaining({ key: row(0).key }),
    ]);
    hydrator.dispose();
  });
  it("fences an old global owner read and clears a denied parent without restoring stale page totals", async () => {
    vi.useFakeTimers();
    let release!: (row: GatewaySessionRow) => void;
    const oldRead = new Promise<GatewaySessionRow>((resolve) => {
      release = resolve;
    });
    const main: GatewaySessionRow = {
      key: "global",
      kind: "global",
      agentId: "main",
      label: "Old owner",
    };
    const other: GatewaySessionRow = {
      key: "global",
      kind: "global",
      agentId: "other",
      label: "Current owner",
    };
    let revision = 1;
    const sessions = {
      get canonicalListRevision() {
        return revision;
      },
      list: vi.fn(async () => result([], 0, 0)),
    } as unknown as SessionCapability;
    const hydrator = new SwarmRosterHydrator();
    const params = {
      sessions,
      parentKey: "global",
      sourceEpoch: 1,
      currentRows: () => [main],
      onRows: () => {},
    };
    hydrator.update({ ...params, agentId: "main", readParent: () => oldRead });
    await vi.advanceTimersByTimeAsync(250);
    hydrator.update({ ...params, agentId: "other", readParent: async () => other });
    await vi.advanceTimersByTimeAsync(250);
    expect(hydrator.rows).toEqual([other]);
    release(main);
    await vi.advanceTimersByTimeAsync(0);
    expect(hydrator.rows).toEqual([other]);
    revision += 1;
    const denied = { ...params, agentId: "other", readParent: async () => null };
    hydrator.update(denied);
    await vi.advanceTimersByTimeAsync(250);
    expect(hydrator.rows).toEqual([]);
    hydrator.update(denied);
    expect(hydrator.rows).toEqual([]);
    hydrator.dispose();
  });
  it("publishes parent counts before slow optional children and retains them when that read fails", async () => {
    vi.useFakeTimers();
    let rejectChildren!: (error: Error) => void;
    const childRead = new Promise<SessionsListResult>((_resolve, reject) => {
      rejectChildren = reject;
    });
    const parent: GatewaySessionRow = {
      key: "agent:main:parent",
      kind: "direct",
      swarm: {
        groups: [{ groupId: "group", createdAt: 1, queued: 0, running: 0, done: 25, failed: 5 }],
        otherActiveGroups: 0,
      },
    };
    const sessions = {
      canonicalListRevision: 1,
      list: vi.fn(() => childRead),
    } as unknown as SessionCapability;
    const hydrator = new SwarmRosterHydrator();
    hydrator.update({
      sessions,
      parentKey: parent.key,
      sourceEpoch: 1,
      readParent: async () => parent,
      currentRows: () => [],
      onRows: () => {},
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(hydrator.rows).toEqual([parent]);
    rejectChildren(new Error("Child details temporarily unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(hydrator.rows).toEqual([parent]);
    hydrator.dispose();
  });
  it.each(["missing", "denied"] as const)(
    "does not restore a %s parent when an earlier child read finishes late",
    async (outcome) => {
      vi.useFakeTimers();
      const children = createDeferred<SessionsListResult>();
      const parent: GatewaySessionRow = {
        key: "agent:main:parent",
        kind: "direct",
        swarm: {
          groups: [{ groupId: "group", createdAt: 1, queued: 0, running: 1, done: 0, failed: 0 }],
          otherActiveGroups: 0,
        },
      };
      let revision = 1;
      const sessions = {
        get canonicalListRevision() {
          return revision;
        },
        list: vi
          .fn()
          .mockReturnValueOnce(children.promise)
          .mockResolvedValue(result([], 0, 0)),
      } as unknown as SessionCapability;
      const onRows = vi.fn();
      const hydrator = new SwarmRosterHydrator();
      const params = {
        sessions,
        parentKey: parent.key,
        sourceEpoch: 1,
        currentRows: () => [parent],
        onRows,
      };
      try {
        hydrator.update({ ...params, readParent: async () => parent });
        await vi.advanceTimersByTimeAsync(250);
        expect(hydrator.rows).toEqual([parent]);
        revision += 1;
        hydrator.update({
          ...params,
          readParent: async () => {
            if (outcome === "denied") {
              throw new GatewayRequestError({
                code: "INVALID_REQUEST",
                message: "Parent unavailable",
              });
            }
            return null;
          },
        });
        await vi.advanceTimersByTimeAsync(250);
        expect(hydrator.rows).toEqual([]);
        children.resolve(result([row(0)], 0, 1));
        await vi.advanceTimersByTimeAsync(0);
        expect(hydrator.rows).toEqual([]);
        expect(onRows).toHaveBeenLastCalledWith([]);
      } finally {
        hydrator.dispose();
      }
    },
  );
});

describe("hydrateSwarmSessionRows", () => {
  it("hydrates paginated cross-agent children outside the normal session page", async () => {
    const children = Array.from({ length: 10_055 }, (_, index) => row(index));
    const list = vi.fn(async (options: SessionListOptions) => {
      const offset = options.offset ?? 0;
      return result(children.slice(offset, offset + 10_000), offset, children.length);
    });
    const currentChild = {
      ...row(0),
      status: "running" as const,
      updatedAt: 2_000,
    } satisfies GatewaySessionRow;
    const currentRows: GatewaySessionRow[] = [
      {
        key: "agent:main:parent",
        kind: "direct",
        updatedAt: 2_000,
      },
      currentChild,
    ];

    const rows = await hydrateSwarmSessionRows({
      sessions: { list } as unknown as SessionCapability,
      parentKey: "agent:main:parent",
      currentRows,
      isCurrent: () => true,
    });

    expect(rows).toHaveLength(10_056);
    expect(rows?.find((candidate) => candidate.key === currentChild.key)?.status).toBe("running");
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        spawnedBy: "agent:main:parent",
        limit: 10_000,
        includeGlobal: false,
        configuredAgentsOnly: true,
      }),
    );
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 10_000 }));
  });

  it("prefers the post-request server row when persisted timestamps tie", async () => {
    const current = { ...row(0), status: "running" as const, updatedAt: 5 };
    const fetched = { ...row(0), status: "done" as const, updatedAt: 5 };

    const rows = await hydrateSwarmSessionRows({
      sessions: {
        list: vi.fn(async () => result([fetched], 0, 1)),
      } as unknown as SessionCapability,
      parentKey: "agent:main:parent",
      currentRows: [current],
      isCurrent: () => true,
    });

    expect(rows).toEqual([expect.objectContaining({ key: fetched.key, status: "done" })]);
  });

  it("restarts pagination when updated rows move across offset boundaries", async () => {
    const running = { ...row(1), status: "running" as const };
    const done = { ...row(1), status: "done" as const, updatedAt: 10 };
    const pages = [
      [row(0), running],
      [running, row(2)],
      [row(3), row(0)],
      [done, row(2)],
    ];
    let callIndex = 0;
    const list = vi.fn(async (options: SessionListOptions) => {
      const rows = pages[callIndex] ?? [];
      callIndex += 1;
      return result(rows, options.offset ?? 0, 4);
    });

    const rows = await hydrateSwarmSessionRows({
      sessions: { list } as unknown as SessionCapability,
      parentKey: "agent:main:parent",
      currentRows: [],
      isCurrent: () => true,
    });

    expect(rows?.map((candidate) => candidate.key).toSorted()).toEqual(
      [row(0).key, row(1).key, row(2).key, row(3).key].toSorted(),
    );
    expect(rows?.find((candidate) => candidate.key === done.key)?.status).toBe("done");
    expect(list).toHaveBeenCalledTimes(4);
  });

  it("keeps the freshest row when hydration overlaps a current-page snapshot", () => {
    const stale = { ...row(0), status: "running" as const, updatedAt: 5, runtimeSampledAt: 10 };
    const fresh = { ...row(0), status: "done" as const, updatedAt: 6, runtimeSampledAt: 20 };

    expect(mergeSwarmSessionRows([fresh], [stale])).toEqual([fresh]);
    expect(mergeSwarmSessionRows([stale], [fresh])).toEqual([fresh]);

    const decorated = { ...stale, status: "done" as const };
    expect(mergeSwarmSessionRows([stale], [decorated])).toEqual([decorated]);
  });

  it("drops stale hydration results", async () => {
    const rows = await hydrateSwarmSessionRows({
      sessions: {
        list: vi.fn(async () => result([row(0)], 0, 1)),
      } as unknown as SessionCapability,
      parentKey: "agent:main:parent",
      currentRows: [],
      isCurrent: () => false,
    });

    expect(rows).toBeNull();
  });
});
