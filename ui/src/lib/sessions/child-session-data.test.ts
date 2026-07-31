import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { fetchChildSessionRows } from "./child-session-data.ts";
import type { SessionCapability } from "./index.ts";

const parentKey = "agent:main:parent";

function childRow(index: number): GatewaySessionRow {
  return {
    key: `agent:worker:child-${index}`,
    spawnedBy: parentKey,
    kind: "direct",
    updatedAt: index,
  };
}

function listResult(
  sessions: GatewaySessionRow[],
  totalCount: number,
  nextOffset: number | null,
): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: sessions.length,
    totalCount,
    hasMore: nextOffset !== null,
    nextOffset,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

describe("fetchChildSessionRows", () => {
  it("loads a default 50-child Swarm roster in one request", async () => {
    const children = Array.from({ length: 50 }, (_, index) => childRow(index));
    const list = vi.fn().mockResolvedValue(listResult(children, children.length, null));

    const rows = await fetchChildSessionRows({
      sessions: { list } as unknown as SessionCapability,
      parentKey,
      isCurrent: () => true,
    });

    expect(rows).toHaveLength(50);
    expect(list).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith({
      spawnedBy: parentKey,
      limit: 100,
      includeGlobal: false,
      includeUnknown: false,
      configuredAgentsOnly: true,
    });
  });

  it("continues paging when a child roster exceeds the default page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => childRow(index));
    const lastPage = [childRow(100)];
    const list = vi
      .fn()
      .mockResolvedValueOnce(listResult(firstPage, 101, 100))
      .mockResolvedValueOnce(listResult(lastPage, 101, null));

    const rows = await fetchChildSessionRows({
      sessions: { list } as unknown as SessionCapability,
      parentKey,
      isCurrent: () => true,
    });

    expect(rows).toHaveLength(101);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[0]).toMatchObject({ offset: 100, limit: 100 });
  });
});
