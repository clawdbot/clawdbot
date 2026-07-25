// sessions_list tool tests cover session metadata projection, visibility
// helpers, and numeric argument validation.
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import { createSessionsListTool } from "./sessions-list-tool.js";

const mocks = vi.hoisted(() => ({
  gatewayCall: vi.fn(),
  createAgentToAgentPolicy: vi.fn(() => ({})),
  createSessionVisibilityGuard: vi.fn(async () => ({
    check: () => ({ allowed: true }),
  })),
  resolveEffectiveSessionToolsVisibility: vi.fn(() => "all"),
  resolveSandboxedSessionToolContext: vi.fn(() => ({
    mainKey: "main",
    alias: "main",
    requesterInternalKey: undefined,
    restrictToSpawned: false,
  })),
  getSessionStateVersions: vi.fn(
    (_refs: Array<{ sessionKey: string; agentId: string }>) =>
      ({}) as Record<string, Record<string, number>>,
  ),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => mocks.gatewayCall(opts),
}));

vi.mock("../../sessions/session-state-events.js", () => ({
  getSessionStateVersions: (refs: Array<{ sessionKey: string; agentId: string }>) =>
    mocks.getSessionStateVersions(refs),
  listAmbientGroupWatchTargets: () => new Set<string>(),
}));

vi.mock("./sessions-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("./sessions-helpers.js")>();
  return {
    ...actual,
    createAgentToAgentPolicy: () => mocks.createAgentToAgentPolicy(),
    createSessionVisibilityGuard: async () => await mocks.createSessionVisibilityGuard(),
    resolveEffectiveSessionToolsVisibility: () => mocks.resolveEffectiveSessionToolsVisibility(),
    resolveSandboxedSessionToolContext: () => mocks.resolveSandboxedSessionToolContext(),
  };
});

type SessionsListDetails = {
  sessions?: Array<{
    channel?: string;
    archived?: boolean;
    pinned?: boolean;
    stateVersion?: number;
    [key: string]: unknown;
  }>;
};

function getSessionsListDetails(result: { details?: unknown }): SessionsListDetails {
  return result.details as SessionsListDetails;
}

describe("sessions-list-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAgentToAgentPolicy.mockReturnValue({});
    mocks.createSessionVisibilityGuard.mockResolvedValue({
      check: () => ({ allowed: true }),
    });
    mocks.resolveEffectiveSessionToolsVisibility.mockReturnValue("all");
    mocks.resolveSandboxedSessionToolContext.mockReturnValue({
      mainKey: "main",
      alias: "main",
      requesterInternalKey: undefined,
      restrictToSpawned: false,
    });
    mocks.getSessionStateVersions.mockReturnValue({});
  });

  it("adds nonzero state versions with one batch lookup", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        { key: "agent:main:main", kind: "main", sessionId: "main-1" },
        { key: "agent:main:subagent:child", kind: "other", sessionId: "child-1" },
      ],
    });
    mocks.getSessionStateVersions.mockReturnValue({
      main: { "agent:main:main": 7, "agent:main:subagent:child": 0 },
    });

    const result = await createSessionsListTool({ config: {} as never }).execute("call-state", {});

    expect(mocks.getSessionStateVersions).toHaveBeenCalledWith([
      { sessionKey: "agent:main:main", agentId: "main" },
      { sessionKey: "agent:main:subagent:child", agentId: "main" },
    ]);
    expect(getSessionsListDetails(result).sessions?.[0]?.stateVersion).toBe(7);
    expect(getSessionsListDetails(result).sessions?.[1]?.stateVersion).toBeUndefined();
  });

  it("never exposes incognito rows to cross-session tools", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "(multiple)",
      sessions: [
        { key: "agent:main:dashboard:visible", kind: "other" },
        { key: "agent:main:dashboard:incognito-private", kind: "other", incognito: true },
      ],
    });

    const result = await createSessionsListTool({ config: {} as never }).execute("blind", {});

    expect(getSessionsListDetails(result).sessions?.map((session) => session.key)).toEqual([
      "agent:main:dashboard:visible",
    ]);
  });

  it("declares a complete focused row contract", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:subagent:child",
          agentId: "main",
          kind: "other",
          channel: "discord",
          label: "worker",
          displayName: "Worker",
          derivedTitle: "Investigate queue",
          lastMessagePreview: "done",
          spawnedBy: "agent:main:main",
          updatedAt: 100,
          archived: false,
          pinned: true,
          model: "openai/gpt-5.4-mini",
          contextTokens: 20_000,
          totalTokens: 1_200,
          status: "done",
          abortedLastRun: false,
          childSessions: ["agent:main:subagent:grandchild"],
        },
      ],
    });
    mocks.getSessionStateVersions.mockReturnValue({
      main: { "agent:main:subagent:child": 4 },
    });
    const tool = createSessionsListTool({ config: {} as never });
    const result = await tool.execute("contract", {});

    expect(tool.outputSchema).toBeDefined();
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      '{ count: number; sessions: Array<{ agentId: string; archived: boolean; channel: string; key: string; kind: "main" | "group" | "cron" | "hook" | "node" | "other"; pinned: boolean; abortedLastRun?: boolean; childSessions?: Array<string>; contextTokens?: number; derivedTitle?: string; displayName?: string; label?: string; lastMessagePreview?: string; messages?: Array<unknown>; model?: string; parentSessionKey?: string; stateVersion?: number; status?: "running" | "done" | "failed" | "killed" | "timeout"; totalTokens?: number; updatedAt?: number }>; visibility?: { mode: "self" | "tree" | "agent"; restricted: true; warning: string } }',
    );
    expect(result.details).toEqual({
      count: 1,
      sessions: [
        {
          key: "agent:main:subagent:child",
          agentId: "main",
          kind: "other",
          channel: "discord",
          archived: false,
          pinned: true,
          label: "worker",
          displayName: "Worker",
          derivedTitle: "Investigate queue",
          lastMessagePreview: "done",
          parentSessionKey: "agent:main:main",
          updatedAt: 100,
          stateVersion: 4,
          model: "openai/gpt-5.4-mini",
          contextTokens: 20_000,
          totalTokens: 1_200,
          status: "done",
          abortedLastRun: false,
          childSessions: ["agent:main:subagent:grandchild"],
        },
      ],
    });
  });

  it("keeps channel discovery but omits delivery routing metadata", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:dashboard:child",
              kind: "direct",
              sessionId: "sess-dashboard-child",
              deliveryContext: {
                channel: "discord",
                to: "discord:child",
                accountId: "acct-1",
                threadId: "thread-1",
              },
            },
            {
              key: "agent:main:telegram:topic",
              kind: "direct",
              sessionId: "sess-telegram-topic",
              deliveryContext: {
                channel: "telegram",
                to: "telegram:topic",
                accountId: "acct-2",
                threadId: 271,
              },
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-1", {});
    const details = getSessionsListDetails(result);

    expect(details.sessions?.map((session) => session.channel)).toEqual(["discord", "telegram"]);
    expect(details.sessions?.every((session) => !Object.hasOwn(session, "deliveryContext"))).toBe(
      true,
    );
  });

  it("prefers the explicit parent key over the legacy spawner", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:subagent:child",
          kind: "other",
          parentSessionKey: "agent:main:subagent:parent",
          spawnedBy: "agent:main:main",
        },
      ],
    });

    const result = await createSessionsListTool({ config: {} as never }).execute("lineage", {});

    expect(getSessionsListDetails(result).sessions?.[0]?.parentSessionKey).toBe(
      "agent:main:subagent:parent",
    );
  });

  it("derives channels only from structurally valid group session keys", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:slack:channel:C123:thread:1710000000.000100",
              kind: "group",
              sessionId: "sess-slack-thread",
            },
            {
              key: "discord:group:ops",
              kind: "group",
              sessionId: "sess-discord-group",
            },
            {
              key: "agent:main:matrix:channel:!room:[2001:db8::1]",
              kind: "group",
              sessionId: "sess-matrix-room",
            },
            {
              key: "agent:main:agent:plugin:slack:channel:C123",
              kind: "group",
              sessionId: "sess-nested-agent",
            },
            {
              key: "agent::slack:channel:C123",
              kind: "group",
              sessionId: "sess-malformed-agent",
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-agent-scoped-channel", {});
    const details = getSessionsListDetails(result);

    expect(details.sessions?.map((session) => session.channel)).toEqual([
      "slack",
      "discord",
      "matrix",
      "unknown",
      "unknown",
    ]);
  });

  it("omits detailed runtime settings from discovery rows", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "main",
              kind: "direct",
              sessionId: "sess-main",
              thinkingLevel: "high",
              fastMode: "auto",
              effectiveFastMode: "auto",
              effectiveFastModeSource: "config",
              fastAutoOnSeconds: 30,
              verboseLevel: "on",
              reasoningLevel: "deep",
              elevatedLevel: "on",
              responseUsage: "full",
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-3", {});
    const details = getSessionsListDetails(result);

    const session = details.sessions?.[0];
    expect(session).toEqual({
      key: "main",
      agentId: "main",
      kind: "main",
      channel: "unknown",
      archived: false,
      pinned: false,
    });
  });

  it("requests archived sessions and keeps management state", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:dashboard:archived",
          kind: "direct",
          archived: true,
          archivedAt: 20,
          pinned: false,
        },
      ],
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-archived", { archived: true });

    expect(mocks.gatewayCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.list",
        params: expect.objectContaining({ archived: true }),
      }),
    );
    expect(getSessionsListDetails(result).sessions?.[0]).toMatchObject({
      archived: true,
      pinned: false,
    });
    expect(getSessionsListDetails(result).sessions?.[0]).not.toHaveProperty("archivedAt");
  });

  it.each([
    [{ limit: 1.5 }, "limit must be a positive integer"],
    [{ activeMinutes: 0 }, "activeMinutes must be a positive integer"],
    [{ messageLimit: 1.5 }, "messageLimit must be a non-negative integer"],
    [{ messageLimit: -1 }, "messageLimit must be a non-negative integer"],
  ])("rejects invalid numeric parameter %o", async (params, message) => {
    // Reject before gateway dispatch so malformed limits cannot reach session
    // store queries.
    const tool = createSessionsListTool({ config: {} as never });

    await expect(tool.execute("call-4", params)).rejects.toThrow(message);
    expect(mocks.gatewayCall).not.toHaveBeenCalled();
  });
});
