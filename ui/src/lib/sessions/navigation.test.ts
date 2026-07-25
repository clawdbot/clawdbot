// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { resolveSessionNavigation, visibleSessionMatches } from "./navigation.ts";

function sessionsResult(sessions: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 1,
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

describe("resolveSessionNavigation", () => {
  it("keeps the selected session in its sorted slot instead of hoisting it", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      key: `agent:main:recent-${index}`,
      kind: "direct" as const,
      updatedAt: 100 - index,
    }));
    const navigation = resolveSessionNavigation({
      result: sessionsResult(rows),
      resultAgentId: "main",
      sessionKey: "agent:main:recent-3",
    });

    expect(navigation.visibleSessions.map((row) => row.key)).toEqual(rows.map((row) => row.key));
    expect(navigation.activeRowKey).toBe("agent:main:recent-3");
  });

  it("hides cron sessions unless showCron opts in", () => {
    const rows: GatewaySessionRow[] = [
      { key: "agent:main:chat", kind: "direct", updatedAt: 300 },
      { key: "agent:main:cron:job", kind: "cron" as never, updatedAt: 200 },
    ];

    const hidden = resolveSessionNavigation({
      result: sessionsResult(rows),
      resultAgentId: "main",
      sessionKey: "agent:main:chat",
    });
    expect(hidden.visibleSessions.map((row) => row.key)).toEqual(["agent:main:chat"]);

    const shown = resolveSessionNavigation({
      result: sessionsResult(rows),
      resultAgentId: "main",
      sessionKey: "agent:main:chat",
      showCron: true,
    });
    expect(shown.visibleSessions.map((row) => row.key)).toEqual([
      "agent:main:chat",
      "agent:main:cron:job",
    ]);
  });

  it("uses the caller's sort order before applying the recent-session projection", () => {
    const navigation = resolveSessionNavigation({
      result: sessionsResult([
        { key: "agent:main:session-c", kind: "direct", updatedAt: 300 },
        { key: "agent:main:session-a", kind: "direct", updatedAt: 100 },
        { key: "agent:main:session-b", kind: "direct", updatedAt: 200 },
      ]),
      resultAgentId: "main",
      sessionKey: "agent:main:session-b",
      compareSessions: (a, b) => a.key.localeCompare(b.key),
    });

    expect(navigation.visibleSessions.map((row) => row.key)).toEqual([
      "agent:main:session-a",
      "agent:main:session-b",
      "agent:main:session-c",
    ]);
    expect(navigation.activeRowKey).toBe("agent:main:session-b");
  });

  it("does not synthesize a session row for a catalog session key", () => {
    const rows = [
      { key: "agent:main:recent-0", kind: "direct" as const, updatedAt: 100 },
      { key: "agent:main:recent-1", kind: "direct" as const, updatedAt: 90 },
    ];
    const navigation = resolveSessionNavigation({
      result: sessionsResult(rows),
      resultAgentId: "main",
      sessionKey: "catalog:claude:gateway%3Alocal:thread-1",
    });

    expect(navigation.visibleSessions.map((row) => row.key)).toEqual(rows.map((row) => row.key));
    expect(navigation.activeRowKey).toBeNull();
    expect(navigation.selectedSession).toBeUndefined();
  });

  it("keeps a deep-linked session ahead of every returned active row", () => {
    const navigation = resolveSessionNavigation({
      result: sessionsResult(
        Array.from({ length: 11 }, (_, index) => ({
          key: `agent:main:recent-${index}`,
          kind: "direct",
          updatedAt: 100 - index,
        })),
      ),
      resultAgentId: "main",
      sessionKey: "agent:main:oldest",
    });

    expect(navigation.visibleSessions).toHaveLength(12);
    expect(navigation.visibleSessions[0]).toMatchObject({
      key: "agent:main:oldest",
      kind: "direct",
      updatedAt: null,
    });
    expect(navigation.activeRowKey).toBe("agent:main:oldest");
    expect(navigation.visibleSessions.slice(1).map((row) => row.key)).toEqual(
      Array.from({ length: 11 }, (_, index) => `agent:main:recent-${index}`),
    );
  });

  it("keeps the selected session in place in a long list", () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      key: `agent:main:recent-${index}`,
      kind: "direct" as const,
      updatedAt: 100 - index,
    }));
    const navigation = resolveSessionNavigation({
      result: sessionsResult(rows),
      resultAgentId: "main",
      sessionKey: "agent:main:recent-11",
    });

    expect(navigation.visibleSessions[11]).toBe(rows[11]);
    expect(navigation.visibleSessions).toHaveLength(12);
    expect(navigation.activeRowKey).toBe("agent:main:recent-11");
  });

  it("keeps every pinned session when many sessions are pinned", () => {
    const pinnedSessions = Array.from({ length: 10 }, (_, index) => ({
      key: `agent:main:pinned-${index}`,
      kind: "direct" as const,
      pinned: true,
      updatedAt: 100 - index,
    }));
    const navigation = resolveSessionNavigation({
      result: sessionsResult([
        { key: "agent:main:recent", kind: "direct", updatedAt: 1_000 },
        ...pinnedSessions,
      ]),
      resultAgentId: "main",
      sessionKey: "unknown",
    });

    expect(navigation.visibleSessions.map((row) => row.key)).toEqual([
      ...pinnedSessions.map((row) => row.key),
      "agent:main:recent",
    ]);
  });

  it("keeps every active chat in addition to pinned sessions", () => {
    const pinnedSessions = Array.from({ length: 3 }, (_, index) => ({
      key: `agent:main:pinned-${index}`,
      kind: "direct" as const,
      pinned: true,
      updatedAt: 100 - index,
    }));
    const recentSessions = Array.from({ length: 10 }, (_, index) => ({
      key: `agent:main:recent-${index}`,
      kind: "direct" as const,
      updatedAt: 1_000 - index,
    }));
    const navigation = resolveSessionNavigation({
      result: sessionsResult([...recentSessions, ...pinnedSessions]),
      resultAgentId: "main",
      sessionKey: "unknown",
    });

    expect(navigation.visibleSessions.map((row) => row.key)).toEqual([
      ...pinnedSessions.map((row) => row.key),
      ...recentSessions.map((row) => row.key),
    ]);
    expect(navigation.activeRowKey).toBeNull();
  });
});

describe("visibleSessionMatches", () => {
  const baseHost = {
    assistantAgentId: "work",
    agentsList: { defaultId: "main", mainKey: "workspace" },
    hello: null,
  };
  const routeGroups: Array<{
    owner: string;
    hostKeys: string[];
    candidates: Array<{ sessionKey: string; agentId?: string }>;
  }> = [
    {
      owner: "main",
      hostKeys: [
        "main",
        "workspace",
        "agent:main:global",
        "agent:main:main",
        "agent:main:workspace",
      ],
      candidates: [
        { sessionKey: "global", agentId: "main" },
        { sessionKey: "main" },
        { sessionKey: "workspace" },
        { sessionKey: "agent:main:global" },
        { sessionKey: "agent:main:main" },
        { sessionKey: "agent:main:workspace" },
      ],
    },
    {
      owner: "work",
      hostKeys: ["global", "agent:work:global", "agent:work:main", "agent:work:workspace"],
      candidates: [
        { sessionKey: "global", agentId: "work" },
        { sessionKey: "agent:work:global" },
        { sessionKey: "agent:work:main" },
        { sessionKey: "agent:work:workspace" },
      ],
    },
    {
      owner: "alpha",
      hostKeys: ["agent:alpha:global", "agent:alpha:main", "agent:alpha:workspace"],
      candidates: [
        { sessionKey: "global", agentId: "alpha" },
        { sessionKey: "agent:alpha:global" },
        { sessionKey: "agent:alpha:main" },
        { sessionKey: "agent:alpha:workspace" },
      ],
    },
  ];

  it("matches every canonical global alias pair only within the same owner", () => {
    for (const hostGroup of routeGroups) {
      for (const hostKey of hostGroup.hostKeys) {
        const host = { ...baseHost, sessionKey: hostKey };
        for (const candidateGroup of routeGroups) {
          for (const candidate of candidateGroup.candidates) {
            expect(
              visibleSessionMatches(host, candidate.sessionKey, candidate.agentId),
              `${hostKey} -> ${candidate.sessionKey} (${candidate.agentId ?? "no agent"})`,
            ).toBe(hostGroup.owner === candidateGroup.owner);
          }
        }
      }
    }
  });

  it("keeps a raw global route tied to the currently selected agent", () => {
    const host = { ...baseHost, sessionKey: "global", assistantAgentId: "alpha" };

    expect(visibleSessionMatches(host, "global", "alpha")).toBe(true);
    expect(visibleSessionMatches(host, "agent:alpha:workspace", "alpha")).toBe(true);
    expect(visibleSessionMatches(host, "global", "work")).toBe(false);
    expect(visibleSessionMatches(host, "global", undefined)).toBe(false);
  });

  it("collapses every main alias when the selected and default agents are the same", () => {
    const hostKeys = [
      "global",
      "main",
      "workspace",
      "agent:work:global",
      "agent:work:main",
      "agent:work:workspace",
    ];
    const candidates: Array<{ sessionKey: string; agentId?: string }> = [
      { sessionKey: "global", agentId: "work" },
      ...hostKeys.slice(1).map((sessionKey) => ({ sessionKey })),
    ];
    for (const hostKey of hostKeys) {
      const host = {
        ...baseHost,
        sessionKey: hostKey,
        agentsList: { defaultId: "work", mainKey: "workspace" },
      };
      for (const candidate of candidates) {
        expect(visibleSessionMatches(host, candidate.sessionKey, candidate.agentId)).toBe(true);
      }
    }
  });

  it("rejects agent metadata that contradicts an alias-owned route", () => {
    const cases = [
      { sessionKey: "main", owner: "main", conflict: "work" },
      { sessionKey: "workspace", owner: "main", conflict: "work" },
      { sessionKey: "agent:main:global", owner: "main", conflict: "work" },
      { sessionKey: "agent:work:main", owner: "work", conflict: "alpha" },
      { sessionKey: "agent:alpha:workspace", owner: "alpha", conflict: "main" },
    ] as const;

    for (const testCase of cases) {
      const host = { ...baseHost, sessionKey: testCase.sessionKey };
      expect(visibleSessionMatches(host, testCase.sessionKey, testCase.owner)).toBe(true);
      expect(visibleSessionMatches(host, testCase.sessionKey, testCase.conflict)).toBe(false);
    }
  });

  it("uses the same canonical owner check for non-global conversations", () => {
    const qualifiedHost = { ...baseHost, sessionKey: "agent:work:room:123" };
    expect(visibleSessionMatches(qualifiedHost, "agent:work:room:123", undefined)).toBe(true);
    expect(visibleSessionMatches(qualifiedHost, "agent:work:room:123", "work")).toBe(true);
    expect(visibleSessionMatches(qualifiedHost, "agent:work:room:123", "alpha")).toBe(false);

    const bareHost = { ...baseHost, sessionKey: "room:123" };
    expect(visibleSessionMatches(bareHost, "room:123", undefined)).toBe(true);
    expect(visibleSessionMatches(bareHost, "room:123", "main")).toBe(true);
    expect(visibleSessionMatches(bareHost, "room:123", "work")).toBe(false);
    expect(visibleSessionMatches(bareHost, "room:456", "main")).toBe(false);
  });
});
