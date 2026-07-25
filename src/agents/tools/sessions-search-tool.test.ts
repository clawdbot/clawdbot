/** sessions_search visibility, bounds, redaction, and input tests. */
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import type { callGateway as gatewayCall } from "../../gateway/call.js";
import { sessionVisibilityGatewayTesting } from "../../plugin-sdk/session-visibility.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";

type CallGatewayRequest = Parameters<typeof gatewayCall>[0];

function hit(overrides: Record<string, unknown> = {}) {
  return {
    sessionKey: "main",
    sessionId: "session-main",
    messageId: "message-1",
    role: "assistant",
    timestamp: 123,
    snippet: "matching text",
    score: 1,
    ...overrides,
  };
}

function createTool(params: {
  results?: Array<Record<string, unknown>>;
  config?: Record<string, unknown>;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  requests?: CallGatewayRequest[];
  truncated?: boolean;
}) {
  return createSessionsSearchTool({
    config: params.config ?? { tools: { sessions: { visibility: "self" } } },
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
    callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
      params.requests?.push(request);
      const results = params.results ?? [];
      if (request.method === "sessions.list") {
        const listParams = request.params as { agentId?: unknown; spawnedBy?: unknown } | undefined;
        const spawnedBy = listParams?.spawnedBy;
        const agentId = listParams?.agentId;
        return {
          sessions: results
            .filter(
              (row) =>
                (spawnedBy === undefined || row.spawnedBy === spawnedBy) &&
                (agentId === undefined || row.agentId === agentId),
            )
            .map((row) => {
              const entry: Record<string, unknown> = { key: row.sessionKey };
              if (typeof row.agentId === "string") {
                entry.agentId = row.agentId;
              }
              if (typeof row.ownerSessionKey === "string") {
                entry.ownerSessionKey = row.ownerSessionKey;
              }
              if (typeof row.parentSessionKey === "string") {
                entry.parentSessionKey = row.parentSessionKey;
              }
              if (typeof row.spawnedBy === "string") {
                entry.spawnedBy = row.spawnedBy;
              }
              return entry;
            }),
          hasMore: false,
        } as T;
      }
      const sessionKeys = (request.params as { sessionKeys?: unknown } | undefined)?.sessionKeys;
      return {
        results: results.filter(
          (row) => Array.isArray(sessionKeys) && sessionKeys.includes(row.sessionKey),
        ),
        ...(params.truncated ? { truncated: true } : {}),
      } as T;
    },
  });
}

afterEach(() => {
  sessionVisibilityGatewayTesting.setCallGatewayForListSpawned();
});

describe("sessions_search tool", () => {
  it("declares exact success and error result contracts", async () => {
    const tool = createTool({ results: [hit()] });
    const success = await tool.execute("success-contract", { query: "text" });
    const error = await tool.execute("error-contract", {
      query: "text",
      sessionKey: "01234567-89ab-4def-8123-456789abcdef",
    });

    expect(tool.outputSchema).toBeDefined();
    expect(Value.Check(tool.outputSchema!, success.details)).toBe(true);
    expect(error.details).toMatchObject({ status: "error", error: expect.any(String) });
    expect(Value.Check(tool.outputSchema!, error.details)).toBe(true);
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      '{ results: Array<{ role: "assistant" | "user"; score: number; sessionKey: string; snippet: string; timestamp: number; messageId?: string; sessionId?: string }>; indexing?: true; truncated?: true } | { error: string; status: "error" | "forbidden" }',
    );
  });

  it("rejects empty queries and invalid limits", async () => {
    const tool = createTool({});
    await expect(tool.execute("call-1", { query: "   " })).rejects.toThrow(
      "query must not be empty",
    );
    await expect(tool.execute("call-2", { query: "ok", limit: 26 })).rejects.toThrow(
      "limit must be a positive integer",
    );
    await expect(tool.execute("call-3", { query: "x".repeat(4097) })).rejects.toThrow(
      "query must not exceed 4096 characters",
    );
  });

  it("filters invisible hits before applying the limit", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      requests,
      results: [
        hit({ sessionKey: "agent:main:other", messageId: "hidden" }),
        hit({ messageId: "visible" }),
      ],
    });

    const result = await tool.execute("call-1", { query: "text", limit: 1 });

    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ messageId: "visible", sessionKey: "main" })],
    });
    expect(JSON.stringify(result.details)).not.toContain("hidden");
    const searchedKeys = requests
      .filter((request) => request.method === "sessions.search")
      .map((request) => (request.params as { sessionKeys?: unknown }).sessionKeys);
    expect(searchedKeys).toEqual([["main"]]);
  });

  it("searches a multi-session visible set in one gateway call", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      requests,
      config: { tools: { sessions: { visibility: "all" } } },
      results: [hit(), hit({ sessionKey: "agent:main:other", messageId: "other" })],
    });

    const result = await tool.execute("call-1", { query: "text" });

    expect(result.details).toMatchObject({ results: expect.arrayContaining([expect.any(Object)]) });
    const searchRequests = requests.filter((request) => request.method === "sessions.search");
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]?.params).toMatchObject({
      agentId: "main",
      sessionKeys: ["agent:main:other", "main"],
    });
  });

  it("never searches or returns incognito sessions", async () => {
    const requests: CallGatewayRequest[] = [];
    const incognitoKey = "agent:main:dashboard:incognito-private";
    const tool = createTool({
      requests,
      config: { tools: { sessions: { visibility: "all" } } },
      results: [
        hit({ sessionKey: "agent:main:visible", messageId: "visible" }),
        hit({ sessionKey: incognitoKey, messageId: "private" }),
      ],
    });

    const result = await tool.execute("blind", { query: "text" });
    const explicit = await tool.execute("blind-explicit", {
      query: "text",
      sessionKey: incognitoKey,
    });

    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ messageId: "visible" })],
    });
    expect(JSON.stringify(result.details)).not.toContain("private");
    expect(explicit.details).toMatchObject({ status: "forbidden" });
    expect(
      requests
        .filter((request) => request.method === "sessions.search")
        .flatMap((request) => {
          const keys = (request.params as { sessionKeys?: unknown }).sessionKeys;
          return Array.isArray(keys) ? keys : [];
        }),
    ).not.toContain(incognitoKey);
  });

  it("excludes foreign unscoped sessions that cannot be reopened by session key", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      requests,
      config: {
        tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      },
      results: [hit({ sessionKey: "global", agentId: "work", messageId: "work-global" })],
    });

    const result = await tool.execute("call-1", { query: "text" });

    const searchRequests = requests.filter((request) => request.method === "sessions.search");
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]?.params).toMatchObject({ agentId: "main" });
    expect(result.details).toMatchObject({ results: [] });
  });

  it("keeps an unscoped current session in the requester agent store", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      requests,
      agentId: "work",
      agentSessionKey: "global",
      config: {
        tools: { sessions: { visibility: "agent" } },
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      },
      results: [
        hit({ sessionKey: "global", agentId: "work" }),
        hit({ sessionKey: "agent:work:other", agentId: "work", messageId: "work-other" }),
      ],
    });

    const result = await tool.execute("call-1", { query: "text" });

    expect(result.details).toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({ sessionKey: "global" }),
        expect.objectContaining({ sessionKey: "agent:work:other" }),
      ]),
    });
    expect(requests).toContainEqual({
      method: "sessions.search",
      params: {
        agentId: "work",
        query: "text",
        limit: 25,
        sessionKeys: ["agent:work:other", "global"],
      },
    });
  });

  it("uses the target agent for an explicit cross-agent session", async () => {
    const requests: CallGatewayRequest[] = [];
    sessionVisibilityGatewayTesting.setCallGatewayForListSpawned(
      async <T>() => ({ sessions: [] }) as T,
    );
    const tool = createTool({
      requests,
      agentId: "main",
      agentSessionKey: "agent:main:main",
      config: {
        tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      },
      results: [hit({ sessionKey: "agent:work:other", agentId: "work" })],
    });

    await tool.execute("call-1", { query: "text", sessionKey: "agent:work:other" });

    expect(requests).toContainEqual({
      method: "sessions.search",
      params: {
        agentId: "work",
        query: "text",
        limit: 25,
        sessionKeys: ["agent:work:other"],
      },
    });
  });

  it("accepts the gateway's canonical key for the current-session alias", async () => {
    const tool = createSessionsSearchTool({
      config: { tools: { sessions: { visibility: "self" } } },
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        if (request.method === "sessions.list") {
          return { sessions: [], hasMore: false } as T;
        }
        return {
          results: [
            hit({ sessionKey: "agent:main:main", messageId: "canonical-main" }),
            hit({ sessionKey: "agent:work:main", messageId: "wrong-agent" }),
          ],
        } as T;
      },
    });

    const result = await tool.execute("call-1", { query: "text" });

    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ messageId: "canonical-main", sessionKey: "main" })],
    });
    expect(JSON.stringify(result.details)).not.toContain("wrong-agent");
  });

  it("clamps sandboxed callers to spawned sessions", async () => {
    const requests: CallGatewayRequest[] = [];
    sessionVisibilityGatewayTesting.setCallGatewayForListSpawned(
      async <T>() => ({ sessions: [{ key: "agent:main:child:spawned" }] }) as T,
    );
    const tool = createTool({
      agentSessionKey: "agent:main:main",
      sandboxed: true,
      requests,
      config: {
        tools: { sessions: { visibility: "all" } },
        agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
      },
      results: [
        hit({
          sessionKey: "agent:main:child:spawned",
          messageId: "spawned",
          spawnedBy: "agent:main:main",
        }),
        hit({ sessionKey: "agent:main:other", messageId: "other" }),
      ],
    });

    const result = await tool.execute("call-1", { query: "text" });

    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ messageId: "spawned" })],
    });
    expect(JSON.stringify(result.details)).not.toContain('"other"');
    const searchedKeys = requests
      .filter((request) => request.method === "sessions.search")
      .map((request) => (request.params as { sessionKeys?: unknown }).sessionKeys);
    expect(searchedKeys).toEqual([["agent:main:child:spawned", "agent:main:main"]]);
  });

  it("keeps archived spawned rows visible from their ownership metadata", async () => {
    sessionVisibilityGatewayTesting.setCallGatewayForListSpawned(
      async <T>() => ({ sessions: [] }) as T,
    );
    const tool = createTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "tree" } } },
      results: [
        hit({
          sessionKey: "agent:main:child:archived",
          messageId: "archived-child",
          spawnedBy: "agent:main:main",
        }),
      ],
    });

    const result = await tool.execute("call-1", { query: "text" });

    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ messageId: "archived-child" })],
    });
  });

  it("redacts and truncates snippets, limits rows, and caps bytes", async () => {
    const token = ["sk", "or", "v1", "abcdef0123456789"].join("-");
    // Assembled so the pre-review secret scanner never sees a key-shaped literal.
    const keyShaped = `${["OPENROUTER", "API", "KEY"].join("_")}=${token}`;
    const results = Array.from({ length: 12 }, (_, index) =>
      hit({
        messageId: `message-${index}`,
        snippet: `${keyShaped} ${"x".repeat(400)}`,
      }),
    );
    const tool = createTool({ results });

    const limited = await tool.execute("call-1", { query: "text", limit: 2 });
    const details = limited.details as { results: unknown[]; truncated?: boolean };
    expect(details.results).toHaveLength(2);
    expect(details.truncated).toBe(true);
    expect(JSON.stringify(details)).not.toContain(token);

    const oversized = createTool({
      results: [hit({ messageId: "x".repeat(40_000) })],
    });
    const capped = await oversized.execute("call-2", { query: "text" });
    expect(capped.details).toMatchObject({ results: [], truncated: true });

    const backendLimited = createTool({ results: [hit()], truncated: true });
    const backendLimitedResult = await backendLimited.execute("call-3", {
      query: "text",
      limit: 2,
    });
    expect(backendLimitedResult.details).toMatchObject({ truncated: true });
  });

  it("resolves and sends a one-session restriction", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({ requests, results: [hit()] });

    await tool.execute("call-1", { query: " text ", sessionKey: "main", limit: 3 });

    expect(requests).toContainEqual({
      method: "sessions.search",
      params: { agentId: "main", query: "text", sessionKeys: ["main"], limit: 25 },
    });
  });
});
