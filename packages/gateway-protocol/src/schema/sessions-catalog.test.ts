import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionCatalogShareRouteSchema,
  SessionsCatalogHostEventSchema,
  SessionsCatalogListParamsSchema,
  SessionsCatalogListResultSchema,
  SessionsCatalogStartTerminalParamsSchema,
  SessionsCatalogStartTerminalResultSchema,
} from "./sessions-catalog.js";

const SHARE_ROUTE = {
  kind: "thread-id-prefix",
  routeSegment: "shared-sessions",
  hostId: "gateway",
  identifierAlphabet: "lowercase-hex",
  fullLength: 32,
  minPrefixLength: 12,
  lookup: "catalog-list-search-by-thread-id-prefix",
  ambiguity: "multiple-results-or-next-cursor",
} as const;

describe("SessionCatalogShareRouteSchema", () => {
  it("accepts only the closed prefix-search contract", () => {
    expect(Value.Check(SessionCatalogShareRouteSchema, SHARE_ROUTE)).toBe(true);
    for (const invalid of [
      { ...SHARE_ROUTE, kind: "future-route" },
      { ...SHARE_ROUTE, identifierAlphabet: "hex" },
      { ...SHARE_ROUTE, fullLength: 64 },
      { ...SHARE_ROUTE, minPrefixLength: 8 },
      { ...SHARE_ROUTE, lookup: "arbitrary-search" },
      { ...SHARE_ROUTE, ambiguity: "first-result" },
      { ...SHARE_ROUTE, unexpected: true },
    ]) {
      expect(Value.Check(SessionCatalogShareRouteSchema, invalid)).toBe(false);
    }
  });
});

describe("SessionsCatalogListResultSchema", () => {
  it("accepts a closed catalog result with hosts", () => {
    expect(
      Value.Check(SessionsCatalogListResultSchema, {
        catalogs: [
          {
            id: "claude",
            label: "Claude Code",
            capabilities: {
              continueSession: true,
              archive: false,
              createSession: {
                model: "anthropic/claude-opus-4-8",
                startTerminal: true,
              },
              openTerminal: true,
            },
            shareRoute: SHARE_ROUTE,
            hosts: [
              {
                hostId: "gateway:local",
                label: "Gateway",
                kind: "gateway",
                connected: true,
                sessions: [
                  {
                    threadId: "thread-1",
                    status: "idle",
                    archived: false,
                    createdActor: { type: "human", id: "profile-ada", label: "Ada" },
                    canContinue: true,
                    canArchive: false,
                    canOpenTerminal: true,
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("SessionsCatalogStartTerminal schemas", () => {
  it("accepts the terminal start contract and rejects unknown fields", () => {
    const params = {
      catalogId: "codex",
      hostId: "gateway:local",
      agentId: "main",
      cwd: "/tmp/worktree",
      initialMessage: "Inspect the failing test",
    };
    const result = {
      sessionId: "terminal-1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/tmp/worktree",
      confined: false,
      title: "Codex",
    };

    expect(Value.Check(SessionsCatalogStartTerminalParamsSchema, params)).toBe(true);
    expect(
      Value.Check(SessionsCatalogStartTerminalParamsSchema, { ...params, unexpected: true }),
    ).toBe(false);
    expect(Value.Check(SessionsCatalogStartTerminalResultSchema, result)).toBe(true);
    expect(
      Value.Check(SessionsCatalogStartTerminalResultSchema, { ...result, unexpected: true }),
    ).toBe(false);
  });
});

describe("SessionsCatalogListParamsSchema", () => {
  it("accepts an optional progressive stream id without a catalog selector", () => {
    expect(
      Value.Check(SessionsCatalogListParamsSchema, {
        agentId: "main",
        progressId: "progress-1",
      }),
    ).toBe(true);
  });

  it("accepts an optional agent scope", () => {
    expect(
      Value.Check(SessionsCatalogListParamsSchema, {
        agentId: "research",
        catalogId: "claude",
      }),
    ).toBe(true);
  });

  it("accepts flat optional catalog cursor fields", () => {
    expect(
      Value.Check(SessionsCatalogListParamsSchema, { cursors: { "gateway:local": "1" } }),
    ).toBe(true);
    expect(
      Value.Check(SessionsCatalogListParamsSchema, {
        catalogId: "claude",
        cursors: { "gateway:local": "1" },
      }),
    ).toBe(true);
  });
});

describe("SessionsCatalogHostEventSchema", () => {
  it("accepts one completed host and rejects unknown fields", () => {
    const event = {
      progressId: "progress-1",
      agentId: "main",
      catalog: {
        id: "codex",
        label: "Codex",
        capabilities: { continueSession: true, archive: true },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Codex",
            kind: "gateway",
            connected: true,
            sessions: [],
          },
        ],
      },
    };

    expect(Value.Check(SessionsCatalogHostEventSchema, event)).toBe(true);
    expect(Value.Check(SessionsCatalogHostEventSchema, { ...event, unexpected: true })).toBe(false);
    expect(
      Value.Check(SessionsCatalogHostEventSchema, {
        ...event,
        catalog: { ...event.catalog, hosts: [] },
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionsCatalogHostEventSchema, {
        ...event,
        catalog: { ...event.catalog, hosts: [event.catalog.hosts[0], event.catalog.hosts[0]] },
      }),
    ).toBe(false);
  });
});
