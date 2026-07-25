import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { SessionCapability, SessionListOptions } from "../sessions/index.ts";
import { hydrateSwarmSessionRows, mergeSwarmSessionRows } from "./swarm-dashboard-roster.ts";
import { isSwarmEnabledInConfig, SwarmRosterHydrator } from "./swarm-dashboard.ts";

function row(index: number): GatewaySessionRow {
  return {
    key: `agent:worker:subagent:${index}`,
    kind: "other",
    updatedAt: index,
    spawnedBy: "agent:main:parent",
    swarmGroupId: "swarm:agent:main:parent:run-1",
  } as unknown as GatewaySessionRow;
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
  it("accepts both the boolean and object configuration forms", () => {
    expect(isSwarmEnabledInConfig({ tools: { swarm: true } })).toBe(true);
    expect(isSwarmEnabledInConfig({ tools: { swarm: { enabled: true } } })).toBe(true);
    expect(isSwarmEnabledInConfig({ tools: { swarm: false } })).toBe(false);
    expect(isSwarmEnabledInConfig({ tools: { swarm: { enabled: false } } })).toBe(false);
    expect(
      isSwarmEnabledInConfig(
        {
          tools: { swarm: false },
          agents: { entries: { worker: { tools: { swarm: true } } } },
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
          agents: { list: [{ id: "worker", tools: { swarm: true } }] },
        },
        "worker",
      ),
    ).toBe(true);
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
      parentKey: "agent:main:parent",
      sourceEpoch: 1,
      currentRows: () => [row(0)],
      onRows,
    });
    expect(hydrator.rows).toHaveLength(1);

    hydrator.update({
      sessions,
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
    const hydrator = new SwarmRosterHydrator();
    const sessions = {
      canonicalListRevision: 0,
      list: vi.fn(async () => result([done], 0, 1)),
    } as unknown as SessionCapability;

    hydrator.update({
      sessions,
      parentKey: "agent:main:parent",
      sourceEpoch: 1,
      currentRows: () => [running],
      onRows: () => undefined,
    });
    await vi.runAllTimersAsync();

    expect(hydrator.rows).toEqual([expect.objectContaining({ status: "done" })]);
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
      parentKey: "agent:main:parent",
      sourceEpoch: 1,
      currentRows: () => [],
      onRows,
    });
    await vi.runAllTimersAsync();

    expect(list).toHaveBeenCalledTimes(4);
    expect(hydrator.rows).toEqual([expect.objectContaining({ key: row(0).key })]);
    hydrator.dispose();
  });
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
        kind: "main",
        updatedAt: 2_000,
      } as unknown as GatewaySessionRow,
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
