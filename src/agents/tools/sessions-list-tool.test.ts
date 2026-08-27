// sessions_list tool tests cover session metadata projection, visibility
// helpers, and numeric argument validation.
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildGatewaySessionRow } from "../../gateway/session-utils-row.js";
import { describeSessionLinkRule } from "../tool-description-presets.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import { createSessionsListTool } from "./sessions-list-tool.js";

const SESSION_LINK_BASE = "http://127.0.0.1:18789/control";
const SESSION_LINK_RULE = describeSessionLinkRule(SESSION_LINK_BASE);

const VALID_CONFIG: OpenClawConfig = {
  agents: { entries: { main: { default: true } } },
};

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
    requesterInternalKey: undefined as string | undefined,
    mainSessionKey: undefined as string | undefined,
    restrictToSpawned: false,
  })),
  getSessionStateVersions: vi.fn(
    (_refs: Array<{ sessionKey: string; agentId: string }>) =>
      ({}) as Record<string, Record<string, number>>,
  ),
}));

vi.mock("./in-process-gateway.js", () => ({
  callAgentToolGatewayRequest: (opts: unknown) => mocks.gatewayCall(opts),
}));

vi.mock("../../sessions/session-state-events.js", () => ({
  getSessionStateVersions: (refs: Array<{ sessionKey: string; agentId: string }>) =>
    mocks.getSessionStateVersions(refs),
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

function sessionRow(key: string, classification = "dashboard", agentId = "main") {
  return { key, agentId, kind: "direct", classification };
}

function mockSessionPages(pages: Array<Array<Record<string, unknown>>>) {
  let pageIndex = 0;
  let nextOffset = 0;
  mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
    const request = opts as { params?: { limit?: number; offset?: number } };
    expect(request.params).toEqual(expect.objectContaining({ limit: 200, offset: nextOffset }));
    const sessions = pages[pageIndex] ?? [];
    pageIndex += 1;
    nextOffset += sessions.length;
    return {
      path: "/tmp/sessions.json",
      sessions,
      hasMore: pageIndex < pages.length,
      nextOffset: pageIndex < pages.length ? nextOffset : null,
    };
  });
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
      mainSessionKey: undefined,
      restrictToSpawned: false,
    });
    mocks.getSessionStateVersions.mockReturnValue({});
  });

  it("filters Gateway-projected agent sessions by their authoritative classification", async () => {
    const entries = [
      ["agent:main:main", { sessionId: "session-main", updatedAt: 5 }],
      [
        "agent:main:slack:channel:C123",
        { sessionId: "session-group", updatedAt: 4, chatType: "channel" },
      ],
      ["agent:main:cron:nightly", { sessionId: "session-cron", updatedAt: 3 }],
      ["agent:main:hook:deploy", { sessionId: "session-hook", updatedAt: 2 }],
      ["agent:main:node-device", { sessionId: "session-node", updatedAt: 1 }],
    ] satisfies Array<[string, SessionEntry]>;
    const store = Object.fromEntries(entries);
    const sessions = entries.map(([key, entry]) =>
      buildGatewaySessionRow({
        cfg: VALID_CONFIG,
        storePath: "/tmp/sessions.json",
        store,
        key,
        entry,
        skipTranscriptUsageFallback: true,
        lightweightListRow: true,
      }),
    );
    mocks.gatewayCall.mockResolvedValue({ path: "/tmp/sessions.json", sessions });
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    const unfiltered = getSessionsListDetails(await tool.execute("all-kinds", {})).sessions ?? [];
    const filteredKeys: Record<string, string[]> = {};
    for (const kind of ["main", "group", "cron", "hook", "node"]) {
      const result = getSessionsListDetails(
        await tool.execute(`filter-${kind}`, { kinds: [kind] }),
      );
      filteredKeys[kind] = (result.sessions ?? []).map((row) => String(row.key));
    }

    expect({
      projected: sessions.map(({ key, kind, classification }) => ({
        key,
        wireKind: kind,
        classification,
      })),
      modelVisible: unfiltered.map(({ key, kind }) => ({ key, kind })),
      filteredKeys,
    }).toEqual({
      projected: [
        { key: "agent:main:main", wireKind: "direct", classification: "main" },
        {
          key: "agent:main:slack:channel:C123",
          wireKind: "group",
          classification: "channel",
        },
        { key: "agent:main:cron:nightly", wireKind: "direct", classification: "cron" },
        { key: "agent:main:hook:deploy", wireKind: "direct", classification: "hook" },
        { key: "agent:main:node-device", wireKind: "direct", classification: "node" },
      ],
      modelVisible: [
        { key: "agent:main:main", kind: "main" },
        { key: "agent:main:slack:channel:C123", kind: "group" },
        { key: "agent:main:cron:nightly", kind: "cron" },
        { key: "agent:main:hook:deploy", kind: "hook" },
        { key: "agent:main:node-device", kind: "node" },
      ],
      filteredKeys: {
        main: ["agent:main:main"],
        group: ["agent:main:slack:channel:C123"],
        cron: ["agent:main:cron:nightly"],
        hook: ["agent:main:hook:deploy"],
        node: ["agent:main:node-device"],
      },
    });
  });

  it("limits session kind arguments to the documented classification values", () => {
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    expect(
      Value.Check(tool.parameters, { kinds: ["main", "group", "cron", "hook", "node", "other"] }),
    ).toBe(true);
    expect(Value.Check(tool.parameters, { kinds: ["unknown"] })).toBe(false);
    expect(Value.Check(tool.parameters, { kinds: ["   "] })).toBe(false);
  });

  it.each([
    { name: "unknown-only", kinds: ["unknown"], expected: [] },
    { name: "whitespace-only", kinds: ["   "], expected: [] },
    { name: "unknown scalar", kinds: "unknown", expected: [] },
    { name: "whitespace scalar", kinds: "   ", expected: [] },
    { name: "known scalar", kinds: "MAIN", expected: ["agent:main:main"] },
    { name: "mixed known and unknown", kinds: ["unknown", "MAIN"], expected: ["agent:main:main"] },
    {
      name: "empty",
      kinds: [],
      expected: ["agent:main:main", "agent:main:slack:channel:team-room"],
    },
  ])("never broadens an explicit $name session kind filter", async ({ kinds, expected }) => {
    mocks.gatewayCall.mockResolvedValue({
      sessions: [
        sessionRow("agent:main:main", "main"),
        sessionRow("agent:main:slack:channel:team-room", "channel"),
        sessionRow("agent:other:main", "main", "other"),
      ],
    });

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute("filter-kinds", {
      kinds,
    });

    expect(getSessionsListDetails(result).sessions?.map((session) => session.key)).toEqual(
      expected,
    );
  });

  it("lists unspawned same-agent sessions from the canonical main session under tree visibility", async () => {
    mocks.resolveEffectiveSessionToolsVisibility.mockReturnValue("tree");
    mocks.resolveSandboxedSessionToolContext.mockReturnValue({
      mainKey: "main",
      alias: "main",
      requesterInternalKey: "agent:main:main",
      mainSessionKey: "agent:main:main",
      restrictToSpawned: false,
    });
    mocks.gatewayCall.mockResolvedValue({
      sessions: [
        sessionRow("agent:main:main", "main"),
        sessionRow("agent:main:slack:channel:team-room", "channel"),
      ],
    });

    const result = await createSessionsListTool({
      agentSessionKey: "agent:main:main",
      config: { ...VALID_CONFIG, tools: { sessions: { visibility: "tree" } } },
    }).execute("main-tree", {});

    expect(getSessionsListDetails(result).sessions?.map((session) => session.key)).toEqual([
      "agent:main:main",
      "agent:main:slack:channel:team-room",
    ]);
  });

  it("keeps a sandboxed main session clamped to spawned rows", async () => {
    mocks.resolveEffectiveSessionToolsVisibility.mockReturnValue("tree");
    mocks.resolveSandboxedSessionToolContext.mockReturnValue({
      mainKey: "main",
      alias: "main",
      requesterInternalKey: "agent:main:main",
      mainSessionKey: undefined,
      restrictToSpawned: true,
    });
    mocks.gatewayCall.mockImplementation(async (request: unknown) => {
      expect(request).toEqual(
        expect.objectContaining({
          params: expect.objectContaining({ spawnedBy: "agent:main:main" }),
        }),
      );
      return { sessions: [sessionRow("agent:main:slack:channel:unspawned", "channel")] };
    });

    const result = await createSessionsListTool({
      agentSessionKey: "agent:main:main",
      sandboxed: true,
      config: { ...VALID_CONFIG, tools: { sessions: { visibility: "all" } } },
    }).execute("sandbox-main", {});

    expect(getSessionsListDetails(result).sessions).toEqual([]);
  });

  it.each([
    {
      name: "hidden and global rows",
      params: { limit: 1 },
      pages: [
        [
          { key: "global", kind: "global", classification: "global", agentId: "main" },
          sessionRow("agent:other:dashboard:hidden", "dashboard", "other"),
        ],
        [sessionRow("agent:main:main", "main")],
      ],
    },
    {
      name: "non-matching kinds",
      params: { kinds: ["main"], limit: 1 },
      pages: [[sessionRow("agent:main:dashboard:other")], [sessionRow("agent:main:main", "main")]],
    },
  ])("fills the requested output limit past $name", async ({ params, pages }) => {
    mockSessionPages(pages);

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute(
      "paged-list",
      params,
    );

    expect(getSessionsListDetails(result).sessions?.map((session) => session.key)).toEqual([
      "agent:main:main",
    ]);
    expect(mocks.gatewayCall).toHaveBeenCalledTimes(2);
  });

  it("fails visibly when Gateway pagination stalls", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [{ key: "global", kind: "global", classification: "global" }],
      hasMore: true,
      nextOffset: 0,
    });

    await expect(
      createSessionsListTool({ config: VALID_CONFIG }).execute("stalled-list", { limit: 1 }),
    ).rejects.toThrow("sessions.list returned invalid pagination");
  });

  it("deduplicates rows when a changing Gateway page overlaps the prior page", async () => {
    const first = sessionRow("agent:main:dashboard:first");
    const overlap = sessionRow("agent:main:dashboard:overlap");
    const finalRow = { ...first, key: "agent:main:dashboard:final" };
    mockSessionPages([
      [first, overlap],
      [overlap, finalRow],
    ]);

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute(
      "overlapping-list",
      { limit: 3 },
    );
    const keys = getSessionsListDetails(result).sessions?.map((session) => session.key) ?? [];

    expect(keys).toEqual([first.key, overlap.key, finalRow.key]);
  });

  it("adds nonzero state versions with one batch lookup", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:main",
          kind: "direct",
          classification: "main",
          sessionId: "main-1",
        },
        {
          key: "agent:main:subagent:child",
          kind: "direct",
          classification: "subagent",
          sessionId: "child-1",
        },
      ],
    });
    mocks.getSessionStateVersions.mockReturnValue({
      main: { "agent:main:main": 7, "agent:main:subagent:child": 0 },
    });

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute("call-state", {});

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
        {
          key: "agent:main:dashboard:visible",
          kind: "direct",
          classification: "dashboard",
          category: "Projects",
        },
        {
          key: "agent:main:dashboard:incognito-private",
          kind: "direct",
          classification: "dashboard",
          incognito: true,
          category: "Secret",
        },
      ],
    });

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute("blind", {});

    expect(
      getSessionsListDetails(result).sessions?.map(({ key, category }) => ({ key, category })),
    ).toEqual([{ key: "agent:main:dashboard:visible", category: "Projects" }]);
  });

  it("declares a complete focused row contract", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:subagent:child",
          sessionId: "session-child",
          agentId: "main",
          kind: "direct",
          classification: "subagent",
          channel: "discord",
          label: "worker",
          category: "P1 issues",
          displayName: "Worker",
          derivedTitle: "Investigate queue",
          lastMessagePreview: "Use `[[reply_to_current]]` literally.",
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
    const tool = createSessionsListTool({ config: VALID_CONFIG });
    const result = await tool.execute("contract", {});
    const linkedTool = createSessionsListTool({
      config: VALID_CONFIG,
      sessionLinkBase: SESSION_LINK_BASE,
    });
    const linkedResult = await linkedTool.execute("linked-contract", {});
    const linkedDetails = linkedResult.details as Record<string, unknown>;

    expect(tool.outputSchema).toBeDefined();
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    expect(result.details).not.toHaveProperty("sessionLinkRule");
    expect(linkedDetails.sessionLinkRule).toBe(SESSION_LINK_RULE);
    expect(linkedTool.description.slice(-SESSION_LINK_RULE.length)).toBe(
      linkedDetails.sessionLinkRule,
    );
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      '{ count: number; sessions: Array<{ agentId: string; archived: boolean; channel: string; key: string; kind: "main" | "group" | "cron" | "hook" | "node" | "other"; pinned: boolean; abortedLastRun?: boolean; category?: string; childSessions?: Array<string>; contextTokens?: number; derivedTitle?: string; displayName?: string; label?: string; lastMessagePreview?: string; messages?: Array<unknown>; model?: string; parentSessionKey?: string; sessionId?: string; stateVersion?: number; status?: "running" | "done" | "failed" | "killed" | "timeout"; totalTokens?: number; updatedAt?: number }>; sessionLinkRule?: string; visibility?: { mode: "self" | "tree" | "agent"; restricted: true; warning: string } }',
    );
    expect(result.details).toEqual({
      count: 1,
      sessions: [
        {
          key: "agent:main:subagent:child",
          sessionId: "session-child",
          agentId: "main",
          kind: "other",
          channel: "discord",
          archived: false,
          pinned: true,
          label: "worker",
          category: "P1 issues",
          displayName: "Worker",
          derivedTitle: "Investigate queue",
          lastMessagePreview: "Use `[[reply_to_current]]` literally.",
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

  it("preserves the context window already projected by the Gateway", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:main",
          agentId: "main",
          kind: "direct",
          classification: "main",
          model: "gpt-5.6-sol",
          contextTokens: 1_000_000,
        },
      ],
    });

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute(
      "gateway-context-window",
      {},
    );

    expect(getSessionsListDetails(result).sessions?.[0]?.contextTokens).toBe(1_000_000);
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
              classification: "dashboard",
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
              classification: "custom",
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
    const tool = createSessionsListTool({ config: VALID_CONFIG });

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
          kind: "direct",
          classification: "subagent",
          parentSessionKey: "agent:main:subagent:parent",
          spawnedBy: "agent:main:main",
        },
      ],
    });

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute("lineage", {});

    expect(getSessionsListDetails(result).sessions?.[0]?.parentSessionKey).toBe(
      "agent:main:subagent:parent",
    );
  });

  it("omits malformed agent keys and derives channels only from valid group keys", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:slack:channel:C123:thread:1710000000.000100",
              kind: "group",
              classification: "thread",
              peerKind: "channel",
              sessionId: "sess-slack-thread",
            },
            {
              key: "discord:group:ops",
              kind: "group",
              classification: "group",
              sessionId: "sess-discord-group",
            },
            {
              key: "agent:main:matrix:channel:!room:[2001:db8::1]",
              kind: "group",
              classification: "channel",
              sessionId: "sess-matrix-room",
            },
            {
              key: "agent:main:agent:plugin:slack:channel:C123",
              kind: "group",
              classification: "custom",
              sessionId: "sess-nested-agent",
            },
            {
              key: "agent::slack:channel:C123",
              kind: "group",
              classification: "channel",
              sessionId: "sess-malformed-agent",
            },
            {
              key: "Agent::discord:channel:C456",
              kind: "group",
              sessionId: "sess-malformed-agent-mixed-case",
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    const result = await tool.execute("call-agent-scoped-channel", {});
    const details = getSessionsListDetails(result);

    expect(details.sessions?.map((session) => session.channel)).toEqual([
      "slack",
      "discord",
      "matrix",
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
              key: "agent:main:main",
              kind: "direct",
              classification: "main",
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
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    const result = await tool.execute("call-3", {});
    const details = getSessionsListDetails(result);

    const session = details.sessions?.[0];
    expect(session).toEqual({
      key: "agent:main:main",
      sessionId: "sess-main",
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
          classification: "dashboard",
          archived: true,
          archivedAt: 20,
          pinned: false,
        },
      ],
    });
    const tool = createSessionsListTool({ config: VALID_CONFIG });

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

  it("keeps a bare row's gateway owner during transcript hydration", async () => {
    mocks.resolveSandboxedSessionToolContext.mockReturnValue({
      mainKey: "main",
      alias: "global",
      requesterInternalKey: "global",
      mainSessionKey: undefined,
      restrictToSpawned: false,
    });
    mocks.gatewayCall
      .mockResolvedValueOnce({
        path: "/tmp/shared-sessions.sqlite",
        sessions: [
          {
            key: "global",
            agentId: "ops",
            kind: "main",
            channel: "webchat",
            archived: false,
            pinned: false,
          },
        ],
      })
      .mockResolvedValueOnce({ messages: [] });
    const config: OpenClawConfig = {
      session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    const result = await createSessionsListTool({
      agentSessionKey: "global",
      requesterAgentIdOverride: "ops",
      config,
    }).execute("owned-row", { messageLimit: 1 });

    expect(getSessionsListDetails(result).sessions?.[0]).toMatchObject({ agentId: "ops" });
    expect(mocks.gatewayCall).toHaveBeenLastCalledWith({
      method: "chat.history",
      params: { sessionKey: "global", agentId: "ops", limit: 1 },
    });
  });

  it("does not attribute an ownerless fixed-store bare row to the requester", async () => {
    mocks.resolveSandboxedSessionToolContext.mockReturnValue({
      mainKey: "main",
      alias: "global",
      requesterInternalKey: "agent:research:main",
      mainSessionKey: "global",
      restrictToSpawned: false,
    });
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/ownerless-shared.sqlite",
      sessions: [
        {
          key: "global",
          kind: "main",
          channel: "webchat",
          archived: false,
          pinned: false,
        },
      ],
    });

    const result = await createSessionsListTool({
      agentSessionKey: "agent:research:main",
      requesterAgentIdOverride: "research",
      config: {
        session: { store: "/tmp/ownerless-shared.sqlite", scope: "global" },
        agents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
      },
    }).execute("ownerless-row", {});

    expect(getSessionsListDetails(result).sessions).toEqual([]);
  });

  it.each([
    [{ limit: 1.5 }, "limit must be a positive integer"],
    [{ activeMinutes: 0 }, "activeMinutes must be a positive integer"],
    [{ messageLimit: 1.5 }, "messageLimit must be a non-negative integer"],
    [{ messageLimit: -1 }, "messageLimit must be a non-negative integer"],
  ])("rejects invalid numeric parameter %o", async (params, message) => {
    // Reject before gateway dispatch so malformed limits cannot reach session
    // store queries.
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    await expect(tool.execute("call-4", params)).rejects.toThrow(message);
    expect(mocks.gatewayCall).not.toHaveBeenCalled();
  });
});
