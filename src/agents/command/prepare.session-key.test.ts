import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AgentSelectionRequiredError } from "../agent-scope.js";
import { resolveExplicitAgentCommandSessionKey } from "./explicit-session-key.js";

const fixedStoreConfig = {
  session: { store: "/stores/shared.sqlite" },
  agents: {
    ownership: "explicit",
    defaults: { sessionStore: { agentId: "ops" } },
    entries: { ops: {}, research: {} },
  },
} satisfies OpenClawConfig;

describe("explicit agent command session keys", () => {
  it("scopes a bare key through its persisted fixed-store owner", () => {
    expect(
      resolveExplicitAgentCommandSessionKey({
        rawExplicitSessionKey: "incident-42",
        shouldScopeDefaultAgentKey: true,
        cfg: fixedStoreConfig,
      }),
    ).toBe("agent:ops:incident-42");
  });

  it("rejects an explicit agent that conflicts with the persisted owner", () => {
    expect(() =>
      resolveExplicitAgentCommandSessionKey({
        rawExplicitSessionKey: "incident-42",
        agentIdOverride: "research",
        shouldScopeDefaultAgentKey: true,
        cfg: fixedStoreConfig,
      }),
    ).toThrow(AgentSelectionRequiredError);
  });

  it("fails closed when the persisted owner has retired", () => {
    expect(() =>
      resolveExplicitAgentCommandSessionKey({
        rawExplicitSessionKey: "incident-42",
        shouldScopeDefaultAgentKey: true,
        cfg: {
          ...fixedStoreConfig,
          agents: {
            ...fixedStoreConfig.agents,
            defaults: { sessionStore: { agentId: "retired" } },
          },
        },
      }),
    ).toThrow(AgentSelectionRequiredError);
  });
});
