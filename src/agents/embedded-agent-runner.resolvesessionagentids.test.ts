// Covers resolving the active agent id from session keys and explicit config.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setRetainedLegacyDefaultAgentId } from "../config/legacy.default-agent-owner-state.js";
import { AgentSelectionRequiredError } from "./agent-scope-config.js";
import {
  resolveSessionAgentIdStrict,
  resolveSessionAgentIds as resolvePairedSessionAgentIds,
} from "./agent-scope.js";

describe("resolveSessionAgentIdStrict", () => {
  it.each([{ agentId: "main" }, { sessionKey: "agent:main:main" }, { fallbackAgentId: "main" }])(
    "does not read unrelated roster entries for a prepared owner: %j",
    (owner) => {
      let unrelatedEntryReads = 0;
      const config: OpenClawConfig = {
        agents: {
          entries: {
            main: {},
            get unrelated() {
              unrelatedEntryReads += 1;
              return {};
            },
          },
        },
      };
      expect(resolveSessionAgentIdStrict({ config, ...owner })).toBe("main");
      expect(unrelatedEntryReads).toBe(0);
    },
  );
});

describe.each([
  { name: "resolveSessionAgentIds", resolve: resolvePairedSessionAgentIds },
  {
    name: "resolveSessionAgentIdStrict",
    resolve: (params: Parameters<typeof resolveSessionAgentIdStrict>[0]) => ({
      sessionAgentId: resolveSessionAgentIdStrict(params),
    }),
  },
])("$name", ({ resolve: resolveSessionAgentIds }) => {
  const cfg = {
    agents: {
      entries: { main: {}, beta: {} },
    },
  } as OpenClawConfig;

  it("treats an explicitly undefined agentId as omitted", () => {
    const config = { agents: { entries: { main: {} } } } as OpenClawConfig;
    expect(resolveSessionAgentIds({ config, agentId: undefined })).toEqual(
      resolveSessionAgentIds({ config }),
    );
  });

  it("requires an owner when sessionKey is missing", () => {
    expect(() => resolveSessionAgentIds({ config: cfg })).toThrow(AgentSelectionRequiredError);
  });

  it.each([
    { config: {}, expected: "main" },
    { config: { agents: { entries: { beta: {} } } }, expected: "beta" },
    {
      config: { agents: { list: [{ id: "main" }, { id: "beta", default: true }] } },
      expected: "beta",
    },
  ])("preserves ownerless fallback for %j", ({ config, expected }) => {
    expect(resolveSessionAgentIds({ config }).sessionAgentId).toBe(expected);
  });

  it("uses the retained migration owner only while it remains configured", () => {
    const config: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, beta: {} } },
    };
    setRetainedLegacyDefaultAgentId(config, "beta");
    expect(resolveSessionAgentIds({ config }).sessionAgentId).toBe("beta");
    setRetainedLegacyDefaultAgentId(config, "retired");
    expect(() => resolveSessionAgentIds({ config })).toThrow(AgentSelectionRequiredError);
  });

  it("requires an owner when sessionKey is non-agent", () => {
    expect(() =>
      resolveSessionAgentIds({ sessionKey: "quietchat:slash:123", config: cfg }),
    ).toThrow(AgentSelectionRequiredError);
  });

  it("requires an owner for global sessions", () => {
    expect(() => resolveSessionAgentIds({ sessionKey: "global", config: cfg })).toThrow(
      AgentSelectionRequiredError,
    );
  });

  it("uses a configured persisted owner for a fixed-store global session", () => {
    expect(
      resolveSessionAgentIds({
        sessionKey: "global",
        config: {
          session: { store: "/tmp/shared.sqlite" },
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "beta" } },
            entries: { main: {}, beta: {} },
          },
        },
      }).sessionAgentId,
    ).toBe("beta");
  });

  it("rejects a retired fixed-store owner for a global session", () => {
    expect(() =>
      resolveSessionAgentIds({
        sessionKey: "global",
        config: {
          session: { store: "/tmp/shared.sqlite" },
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "retired" } },
            entries: { main: {}, beta: {} },
          },
        },
      }),
    ).toThrow(AgentSelectionRequiredError);
  });

  it("rejects an explicit agent that conflicts with a configured fixed-store owner", () => {
    expect(() =>
      resolveSessionAgentIds({
        agentId: "main",
        sessionKey: "global",
        config: {
          session: { store: "/tmp/shared.sqlite" },
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "beta" } },
            entries: { main: {}, beta: {} },
          },
        },
      }),
    ).toThrow(AgentSelectionRequiredError);
  });

  it("rejects a fallback agent that conflicts with a configured fixed-store owner", () => {
    expect(() =>
      resolveSessionAgentIds({
        fallbackAgentId: "main",
        sessionKey: "global",
        config: {
          session: { store: "/tmp/shared.sqlite" },
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "beta" } },
            entries: { main: {}, beta: {} },
          },
        },
      }),
    ).toThrow(AgentSelectionRequiredError);
  });

  it("rejects an explicit agent when the unscoped fixed-store owner retired", () => {
    expect(() =>
      resolveSessionAgentIds({
        agentId: "beta",
        sessionKey: "global",
        config: {
          session: { store: "/tmp/shared.sqlite" },
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "retired" } },
            entries: { main: {}, beta: {} },
          },
        },
      }),
    ).toThrow(AgentSelectionRequiredError);
  });

  it("keeps an agent-scoped key available when the fixed-store owner retired", () => {
    expect(
      resolveSessionAgentIds({
        agentId: "beta",
        sessionKey: "agent:beta:main",
        config: {
          session: { store: "/tmp/shared.sqlite" },
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "retired" } },
            entries: { main: {}, beta: {} },
          },
        },
      }).sessionAgentId,
    ).toBe("beta");
  });

  it("rejects an explicit agent that conflicts with an agent-scoped key", () => {
    expect(() =>
      resolveSessionAgentIds({
        agentId: "main",
        sessionKey: "agent:beta:main",
        config: cfg,
      }),
    ).toThrow(AgentSelectionRequiredError);
  });

  it("keeps the agent id for provider-qualified agent sessions", () => {
    // Channel-qualified agent session keys still carry the owning agent in the
    // second segment.
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "agent:beta:quietchat:channel:c1",
      config: cfg,
    });
    expect(sessionAgentId).toBe("beta");
  });

  it("uses the agent id from agent session keys", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "agent:main:main",
      config: cfg,
    });
    expect(sessionAgentId).toBe("main");
  });

  it("uses explicit agentId when sessionKey is missing", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      agentId: "main",
      config: cfg,
    });
    expect(sessionAgentId).toBe("main");
  });

  it("prefers explicit agentId over non-agent session keys", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "quietchat:slash:123",
      agentId: "main",
      config: cfg,
    });
    expect(sessionAgentId).toBe("main");
  });

  it("uses fallbackAgentId for unscoped channel session keys", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "feishu:direct:ou_user1",
      fallbackAgentId: "main",
      config: cfg,
    });
    expect(sessionAgentId).toBe("main");
  });

  it("prefers session-key agent over fallbackAgentId", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "agent:beta:feishu:direct:ou_user1",
      fallbackAgentId: "main",
      config: cfg,
    });
    expect(sessionAgentId).toBe("beta");
  });

  it("prefers explicit agentId over fallbackAgentId", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "feishu:direct:ou_user1",
      agentId: "beta",
      fallbackAgentId: "main",
      config: cfg,
    });
    expect(sessionAgentId).toBe("beta");
  });
});

it.each(["raw", "retained"])("preserves a different %s default for paired callers", (source) => {
  const config: OpenClawConfig = {
    agents: { entries: { main: { default: source === "raw" }, beta: {} } },
  };
  if (source === "retained") {
    setRetainedLegacyDefaultAgentId(config, "main");
  }
  expect(resolvePairedSessionAgentIds({ config, agentId: "beta" })).toEqual({
    defaultAgentId: "main",
    sessionAgentId: "beta",
  });
  expect(resolveSessionAgentIdStrict({ config, agentId: "beta" })).toBe("beta");
});
