// @vitest-environment node
import { parseAgentSessionKeyParts } from "@openclaw/session-url-contract";
import { describe, expect, it } from "vitest";
import {
  canArchiveSessionRow,
  canDeleteSessionRows,
  canonicalUiSessionKeyForPersistence,
  isUiSelectedGlobalSessionKey,
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
  parseSessionKeyParts,
  resolveAgentIdFromSessionKey,
  resolveUiSessionNavigationParentKey,
  resolveUiConversationIdentity,
  uiSessionEventMatches,
  uiSessionRowMatchesSelectedChat,
} from "./session-key.ts";

describe("Dashboard fixture session keys", () => {
  it.each([
    ["agent:main:main", "main", "main"],
    ["agent:ops:home", "ops", "home"],
    ["agent:ops:current", "ops", "current"],
    ["agent:research:main:thread", "research", "main:thread"],
    ["agent:main:dashboard:uuid", "main", "dashboard:uuid"],
    [
      "agent:main:dashboard:0f9d5c1e-6d0f-4c9a-9d84-1c2f3a4b5c6d",
      "main",
      "dashboard:0f9d5c1e-6d0f-4c9a-9d84-1c2f3a4b5c6d",
    ],
    ["agent:main:node-proof-claude", "main", "node-proof-claude"],
    ["agent:main:explicit:node-mcp-debug", "main", "explicit:node-mcp-debug"],
    ["agent:main:telegram:direct:42", "main", "telegram:direct:42"],
    ["agent:main:telegram:cards:dm:42", "main", "telegram:cards:dm:42"],
    ["agent:main:telegram:cards:direct:42", "main", "telegram:cards:direct:42"],
    ["agent:main:telegram:default:direct:42", "main", "telegram:default:direct:42"],
    ["agent:main:telegram:direct:12345😀67890", "main", "telegram:direct:12345😀67890"],
    ["agent:main:telegram:group:-1001234567890", "main", "telegram:group:-1001234567890"],
    ["agent:main:slack:channel:C1", "main", "slack:channel:C1", "slack:channel:c1"],
    ["agent:main:dm:+123", "main", "dm:+123"],
    ["agent:main:direct:+123", "main", "direct:+123"],
    ["agent:main:dm:account:group:room", "main", "dm:account:group:room"],
    [
      "agent:main:slack:acct-1:channel:C1",
      "main",
      "slack:acct-1:channel:C1",
      "slack:acct-1:channel:c1",
    ],
    [
      "agent:data-expert:dingtalk:cidzg6sF43NZMy52Rnk8EN",
      "data-expert",
      "dingtalk:cidzg6sF43NZMy52Rnk8EN",
      "dingtalk:cidzg6sf43nzmy52rnk8en",
    ],
    ["agent:main:telegram:user:12345:extra", "main", "telegram:user:12345:extra"],
    ["agent:main:subagent:worker", "main", "subagent:worker"],
    ["agent:main:cron:daily", "main", "cron:daily"],
    [
      "agent:ops:catalog:fixture:node%3ADevBox:Thread%3AA",
      "ops",
      "catalog:fixture:node%3ADevBox:Thread%3AA",
      "catalog:fixture:node%3adevbox:thread%3aa",
    ],
    [
      "agent:ops:matrix:channel:!Room:Example.Org:thread:$Event",
      "ops",
      "matrix:channel:!Room:Example.Org:thread:$Event",
      "matrix:channel:!room:example.org:thread:$event",
    ],
    [
      "agent:ops:signal:group:AbC123=:thread:xyz",
      "ops",
      "signal:group:AbC123=:thread:xyz",
      "signal:group:abc123=:thread:xyz",
    ],
  ] as const)("retains ownership and tail for %s", (key, agentId, rest, uiRest?: string) => {
    expect(parseAgentSessionKeyParts(key)).toEqual({ agentId, rest });
    expect(parseAgentSessionKey(key)).toEqual({ agentId, rest: uiRest ?? rest });
  });

  it.each(["main", "global", "unknown", "catalog:claude:gateway%3Alocal:thread-1"])(
    "keeps %s unscoped while retaining the UI owner fallback",
    (key) => {
      expect(parseAgentSessionKeyParts(key)).toBeNull();
      expect(parseAgentSessionKey(key)).toBeNull();
      expect(resolveAgentIdFromSessionKey(key)).toBe("main");
    },
  );

  it.each([
    ["agent:ops:room::part", { agentId: "ops", rest: "room::part" }, "ops", "room:part"],
    ["agent:ops:main:", { agentId: "ops", rest: "main:" }, "ops", "main"],
    ["agent:ops::cron:job", null, "ops", "cron:job"],
    ["agent::cron:job", null, "cron", "job"],
    [":agent:ops:main", null, "ops", "main"],
    ["agent:ops: :", { agentId: "ops", rest: " :" }, "ops", " "],
  ] as const)("preserves the display adapter's accepted shape %s", (key, raw, agentId, rest) => {
    expect(parseAgentSessionKeyParts(key)).toEqual(raw);
    expect(parseAgentSessionKey(key)).toEqual({ agentId, rest });
    expect(resolveAgentIdFromSessionKey(key)).toBe(agentId);
  });

  it("retains the UI fallback for a malformed owner", () => {
    expect(parseAgentSessionKey("agent::secret")).toBeNull();
    expect(resolveAgentIdFromSessionKey("agent::secret")).toBe("main");
  });
});

describe("session archive eligibility", () => {
  it.each([
    ["active non-main", { key: "agent:main:work", hasActiveRun: true }, true, false],
    ["idle non-main", { key: "agent:main:work" }, true, true],
    ["configured main", { key: "agent:main:home" }, false, false],
    ["literal main", { key: "main" }, false, false],
    ["global", { key: "global", kind: "global" }, false, false],
    ["unknown", { key: "unknown", kind: "unknown" }, false, false],
    ["archived global", { key: "global", kind: "global", archived: true }, false, true],
  ] as const)("classifies %s", (_name, row, archiveAllowed, deleteAllowed) => {
    expect(canArchiveSessionRow({ sessionId: "durable-session", ...row }, "home")).toBe(
      archiveAllowed,
    );
    expect(canDeleteSessionRows([row], "home")).toBe(deleteAllowed);
  });

  it("rejects lifecycle actions for a row without a durable identity", () => {
    expect(canArchiveSessionRow({ key: "agent:main:work" }, "home")).toBe(false);
  });

  it("keeps mixed archived and idle batch deletion disabled", () => {
    expect(
      canDeleteSessionRows(
        [
          { key: "global", kind: "global", archived: true },
          { key: "agent:main:work", archived: false },
        ],
        "home",
      ),
    ).toBe(false);
  });
});

describe("parseSessionKeyParts", () => {
  it("preserves opaque channel account tails", () => {
    expect(parseSessionKeyParts("agent:data-expert:dingtalk:cidzg6sF43NZMy52Rnk8EN")).toEqual({
      agentId: "data-expert",
      channel: "dingtalk",
      accountId: "cidzg6sF43NZMy52Rnk8EN",
    });
    expect(parseSessionKeyParts("agent:main:telegram:user:12345:extra")).toEqual({
      agentId: "main",
      channel: "telegram",
      accountId: "user:12345:extra",
    });
  });

  it.each([
    "global:default",
    "direct:some-key",
    "",
    "agent:",
    "agent:main",
    "agent:main:",
    "agent:main:telegram",
    "Agent:main:telegram:user",
  ])("rejects malformed key %j", (key) => {
    expect(parseSessionKeyParts(key)).toBeNull();
  });
});

describe("UI session identity", () => {
  it.each([
    [
      "Agent:Ops:Catalog:Fixture:Node%3ADevBox:Thread%3AA",
      "agent:ops:Catalog:Fixture:Node%3ADevBox:Thread%3AA",
    ],
    ["agent:ops:other:signal:group:AbC", "agent:ops:other:signal:group:abc"],
    ["agent:ops:signal:group:AbC:signal:group:DeF", "agent:ops:signal:group:AbC:signal:group:def"],
    [":Matrix:Channel:!Room:Org", ":matrix:channel:!Room:Org"],
    ["agent:ops: :Matrix:Channel:!Room:Org", "agent:ops: :matrix:channel:!Room:Org"],
    [
      "agent:ops:matrix:channel: !Room:Org :thread:$Event",
      "agent:ops:matrix:channel: !Room:Org :thread:$Event",
    ],
  ])("retains UI comparison normalization for %s", (key, expected) => {
    expect(normalizeSessionKeyForUiComparison(key)).toBe(expected);
  });

  it.each([
    {
      name: "native catalog source IDs",
      selectedKey: "agent:ops:catalog:fixture:node%3ADevBox:Thread%3AA",
      structuralAlias: "Agent:Ops:catalog:fixture:node%3ADevBox:Thread%3AA",
      distinctKey: "agent:ops:catalog:fixture:node%3ADevBox:thread%3Aa",
    },
    {
      name: "Matrix room IDs",
      selectedKey: "agent:ops:matrix:channel:!Room:Example.Org",
      structuralAlias: "Agent:Ops:Matrix:Channel:!Room:Example.Org",
      distinctKey: "agent:ops:matrix:channel:!room:example.org",
    },
    {
      name: "Matrix room and thread IDs",
      selectedKey: "agent:ops:matrix:channel:!Room:Example.Org:thread:$Event",
      structuralAlias: "Agent:Ops:Matrix:Channel:!Room:Example.Org:Thread:$Event",
      distinctKey: "agent:ops:matrix:channel:!Room:Example.Org:thread:$event",
    },
    {
      name: "Signal group IDs",
      selectedKey: "agent:ops:signal:group:AbC123=",
      structuralAlias: "Agent:Ops:Signal:Group:AbC123=",
      distinctKey: "agent:ops:signal:group:abc123=",
    },
    {
      name: "Signal group IDs with normalized thread suffixes",
      selectedKey: "agent:ops:signal:group:AbC123=:thread:xyz",
      structuralAlias: "Agent:Ops:Signal:Group:AbC123=:Thread:XyZ",
      distinctKey: "agent:ops:signal:group:abc123=:thread:xyz",
    },
  ])(
    "preserves $name in live events and persisted session identity",
    ({ selectedKey, structuralAlias, distinctKey }) => {
      const host = {
        agentsList: { defaultId: "ops", mainKey: "home" },
        sessionKey: selectedKey,
      };

      expect(uiSessionEventMatches(host, structuralAlias)).toBe(true);
      expect(uiSessionEventMatches(host, distinctKey)).toBe(false);
      expect(canonicalUiSessionKeyForPersistence(host, structuralAlias)).toBe(selectedKey);
      expect(canonicalUiSessionKeyForPersistence(host, distinctKey)).toBe(distinctKey);
    },
  );

  it("retains configured main-session aliases for events and persisted identity", () => {
    const host = {
      agentsList: { defaultId: "ops", mainKey: "home" },
      sessionKey: "agent:ops:home",
    };

    expect(uiSessionEventMatches(host, "main")).toBe(true);
    expect(uiSessionEventMatches(host, "agent:ops:main")).toBe(true);
    expect(canonicalUiSessionKeyForPersistence(host, "main")).toBe("agent:ops:home");
    expect(canonicalUiSessionKeyForPersistence(host, "agent:ops:main")).toBe("agent:ops:home");
    expect(isUiSelectedGlobalSessionKey(host, "agent:ops:home")).toBe(false);
    expect(isUiSelectedGlobalSessionKey(host, "agent:ops:main")).toBe(false);
    expect(isUiSelectedGlobalSessionKey(host, "agent:ops:other")).toBe(false);
  });

  it.each([
    ["main", undefined, "agent:ops:current", "ops"],
    ["home", undefined, "agent:ops:current", "ops"],
    ["agent:ops:main", undefined, "agent:ops:current", "ops"],
    ["agent:ops:home", undefined, "agent:ops:current", "ops"],
    ["agent:work:main", undefined, "agent:work:home", "work"],
    ["main", { defaultId: "work", mainKey: "home" }, "agent:work:home", "work"],
    ["main", { defaultId: "ops", mainKey: "next" }, "agent:ops:next", "ops"],
    ["main", { defaultId: "ops", mainKey: "home", scope: "global" }, "global", "ops"],
    ["main", undefined, "agent:work:home", "work", "work"],
    ["home", undefined, "agent:work:home", "work", "work"],
    ["main", { defaultId: "ops", mainKey: "home", scope: "global" }, "global", "work", "work"],
    ["agent:ops:main", undefined, "agent:ops:current", "ops", "work"],
  ] as const)(
    "uses advertised main identity for %s without overriding current roster %j",
    (key, agentsList, sessionKey, agentId, agentIdOverride?: string) => {
      const host = {
        agentsList,
        assistantAgentId: agentId,
        hello: {
          snapshot: {
            sessionDefaults: {
              defaultAgentId: "ops",
              mainKey: "home",
              mainSessionKey: "agent:ops:current",
            },
          },
        },
      };
      expect(resolveUiConversationIdentity(host, key, agentIdOverride)).toEqual({
        sessionKey,
        agentId,
      });
      expect(uiSessionEventMatches({ ...host, sessionKey }, key, agentId)).toBe(true);
      expect(uiSessionEventMatches({ ...host, sessionKey }, key, "unrelated")).toBe(false);
    },
  );

  it.each([
    {
      parentSessionKey: "  agent:main:dashboard:navigation-parent  ",
      spawnedBy: "agent:main:controller",
      expected: "agent:main:dashboard:navigation-parent",
    },
    {
      parentSessionKey: "",
      spawnedBy: "  agent:main:controller  ",
      expected: "agent:main:controller",
    },
    {
      parentSessionKey: "  \t  ",
      spawnedBy: "agent:main:controller",
      expected: "agent:main:controller",
    },
    { parentSessionKey: null, spawnedBy: "  ", expected: undefined },
  ])("resolves the first non-empty navigation parent", ({ expected, ...row }) => {
    expect(resolveUiSessionNavigationParentKey(row)).toBe(expected);
  });
});

describe("canonical host-scoped event and row matching", () => {
  const host = {
    agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
  };
  it.each(["event", "row"])("separates global from per-sender main in %s matching", (surface) => {
    expect(
      surface === "event"
        ? uiSessionEventMatches(host, "global", "main")
        : uiSessionRowMatchesSelectedChat(host, "global", host.sessionKey),
    ).toBe(false);
  });
  it("retains configured-global aliases without joining another global agent", () => {
    const global = {
      ...host,
      agentsList: { ...host.agentsList, scope: "global" },
      sessionKey: "agent:work:main",
      assistantAgentId: "main",
    };
    expect(uiSessionEventMatches(global, "global", "work")).toBe(true);
    expect(uiSessionEventMatches(global, "global", "main")).toBe(false);
    expect(uiSessionEventMatches(global, "agent:main:main")).toBe(false);
  });
  it("rejects contradictory agent evidence while preserving deliberately unscoped events", () => {
    expect(uiSessionEventMatches(host, host.sessionKey, "work")).toBe(false);
    for (const key of [undefined, null, ""]) {
      expect(uiSessionEventMatches(host, key, "work")).toBe(true);
    }
  });
  it("matches configured custom main rows and keeps literal global separate", () => {
    const custom = {
      ...host,
      agentsList: { defaultId: "ops", mainKey: "home", scope: "per-sender" },
      sessionKey: "agent:ops:home",
    };
    expect(uiSessionRowMatchesSelectedChat(custom, "main", custom.sessionKey)).toBe(true);
    expect(uiSessionRowMatchesSelectedChat(custom, "global", custom.sessionKey)).toBe(false);
  });
});
