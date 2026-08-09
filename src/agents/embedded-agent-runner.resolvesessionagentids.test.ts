// Covers resolving the active agent id from session keys and explicit config.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { AgentSelectionRequiredError } from "./agent-scope-config.js";
import { resolveSessionAgentIds } from "./agent-scope.js";

describe("resolveSessionAgentIds", () => {
  const cfg = {
    agents: {
      entries: { main: {}, beta: {} },
    },
  } as OpenClawConfig;

  it("requires an owner when sessionKey is missing", () => {
    expect(() => resolveSessionAgentIds({ config: cfg })).toThrow(AgentSelectionRequiredError);
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
