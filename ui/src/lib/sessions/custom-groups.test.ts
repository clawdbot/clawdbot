import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  dissolveSessionGroup,
  loadStoredSessionCustomGroups,
  reorderSessionCustomGroups,
  renameSessionGroup,
  saveStoredSessionCustomGroups,
} from "./custom-groups.ts";
import type { SessionListOptions, SessionPatch } from "./index.ts";

function row(key: string, category?: string): GatewaySessionRow {
  return { key, kind: "direct", updatedAt: null, category };
}

function listResult(
  sessions: GatewaySessionRow[],
  page: { hasMore?: boolean; nextOffset?: number | null } = {},
): SessionsListResult {
  return {
    sessions,
    hasMore: page.hasMore ?? false,
    nextOffset: page.nextOffset ?? null,
  } as SessionsListResult;
}

function fakeSessions(params: {
  active: GatewaySessionRow[];
  archived?: GatewaySessionRow[];
  failKeys?: readonly string[];
  pageSize?: number;
}) {
  const patches: Array<{ key: string; patch: SessionPatch; agentId?: string }> = [];
  return {
    patches,
    list: vi.fn(async (options?: SessionListOptions) => {
      const rows = options?.showArchived ? (params.archived ?? []) : params.active;
      const pageSize = params.pageSize ?? (rows.length || 1);
      const offset = options?.offset ?? 0;
      const page = rows.slice(offset, offset + pageSize);
      const nextOffset = offset + page.length;
      return listResult(page, {
        hasMore: nextOffset < rows.length,
        nextOffset: nextOffset < rows.length ? nextOffset : null,
      });
    }),
    patch: vi.fn(async (key: string, patch: SessionPatch, options?: { agentId?: string }) => {
      if (params.failKeys?.includes(key)) {
        throw new Error(`patch failed: ${key}`);
      }
      patches.push({ key, patch, agentId: options?.agentId });
      return null;
    }),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renameSessionGroup", () => {
  it("renames the stored group and every member session, including archived rows", async () => {
    saveStoredSessionCustomGroups(["Research", "Apps"]);
    const sessions = fakeSessions({
      active: [
        row("agent:main:paper-a", "Research"),
        row("agent:main:paper-b", "Research"),
        row("agent:main:other", "Apps"),
        row("agent:main:plain"),
      ],
      archived: [row("agent:main:old-notes", "Research")],
    });

    await renameSessionGroup(sessions, "Research", "Projects");

    expect(loadStoredSessionCustomGroups()).toEqual(["Projects", "Apps"]);
    expect(sessions.patches).toEqual([
      { key: "agent:main:paper-a", patch: { category: "Projects" }, agentId: "main" },
      { key: "agent:main:paper-b", patch: { category: "Projects" }, agentId: "main" },
      { key: "agent:main:old-notes", patch: { category: "Projects" }, agentId: "main" },
    ]);
    // Both windows page explicitly: an absent limit is capped at 100 rows
    // server-side, and archived rows must keep their group on restore.
    expect(sessions.list).toHaveBeenCalledWith({ activeMinutes: 0, limit: 200 });
    expect(sessions.list).toHaveBeenCalledWith({
      activeMinutes: 0,
      limit: 200,
      showArchived: true,
    });
  });

  it("pages through nextOffset so members beyond the first window are renamed", async () => {
    const active = Array.from({ length: 5 }, (_, index) =>
      row(`agent:main:s-${index}`, index >= 3 ? "Research" : "Other"),
    );
    const sessions = fakeSessions({ active, pageSize: 2 });

    await renameSessionGroup(sessions, "Research", "Projects");

    expect(sessions.patches.map((entry) => entry.key)).toEqual([
      "agent:main:s-3",
      "agent:main:s-4",
    ]);
    expect(sessions.list).toHaveBeenCalledWith({ activeMinutes: 0, limit: 200, offset: 2 });
    expect(sessions.list).toHaveBeenCalledWith({ activeMinutes: 0, limit: 200, offset: 4 });
  });

  it("remembers the new name when renaming a group only discovered from rows", async () => {
    const sessions = fakeSessions({ active: [row("agent:main:a", "Loose")] });
    await renameSessionGroup(sessions, "Loose", "Tidy");
    expect(loadStoredSessionCustomGroups()).toEqual(["Tidy"]);
  });

  it("dedupes rows returned by both list windows", async () => {
    const shared = row("agent:main:both", "Research");
    const sessions = fakeSessions({ active: [shared], archived: [shared] });
    await renameSessionGroup(sessions, "Research", "Projects");
    expect(sessions.patches).toHaveLength(1);
  });

  it("keeps patching remaining members when one patch fails", async () => {
    const sessions = fakeSessions({
      active: [row("agent:main:bad", "Research"), row("agent:main:good", "Research")],
      failKeys: ["agent:main:bad"],
    });
    await renameSessionGroup(sessions, "Research", "Projects");
    expect(sessions.patches.map((entry) => entry.key)).toEqual(["agent:main:good"]);
  });
});

describe("reorderSessionCustomGroups", () => {
  it("moves a group before the drop target and keeps the rest stable", () => {
    expect(reorderSessionCustomGroups(["Alpha", "Beta", "Gamma"], "Gamma", "Alpha")).toEqual([
      "Gamma",
      "Alpha",
      "Beta",
    ]);
    expect(reorderSessionCustomGroups(["Alpha", "Beta", "Gamma"], "Alpha", "Gamma")).toEqual([
      "Beta",
      "Alpha",
      "Gamma",
    ]);
    expect(
      reorderSessionCustomGroups(["Alpha", "Beta", "Gamma"], "Alpha", "Gamma", "after"),
    ).toEqual(["Beta", "Gamma", "Alpha"]);
  });
});

describe("dissolveSessionGroup", () => {
  it("drops the stored group and moves member sessions back to ungrouped", async () => {
    saveStoredSessionCustomGroups(["Research", "Apps"]);
    const sessions = fakeSessions({
      active: [row("agent:main:paper-a", "Research"), row("agent:main:other", "Apps")],
      archived: [row("agent:main:old-notes", "Research")],
    });

    await dissolveSessionGroup(sessions, "Research");

    expect(loadStoredSessionCustomGroups()).toEqual(["Apps"]);
    expect(sessions.patches).toEqual([
      { key: "agent:main:paper-a", patch: { category: null }, agentId: "main" },
      { key: "agent:main:old-notes", patch: { category: null }, agentId: "main" },
    ]);
  });
});
