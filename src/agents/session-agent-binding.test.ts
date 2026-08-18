import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveBoundAgentIdForSession } from "./session-agent-binding.js";

describe("resolveBoundAgentIdForSession", () => {
  const multiAgentConfig = {
    agents: { entries: { main: {}, research: {} } },
  } satisfies OpenClawConfig;
  const singleAgentConfig = {
    agents: { entries: { main: {} } },
  } satisfies OpenClawConfig;

  it.each([
    {
      name: "an explicit agent id",
      params: { config: multiAgentConfig, agentId: "research", sessionKey: "legacy-session" },
      expected: "research",
    },
    {
      name: "an agent-scoped key",
      params: { config: multiAgentConfig, sessionKey: "agent:research:session:abc" },
      expected: "research",
    },
    {
      name: "the canonical main key",
      params: { config: singleAgentConfig, sessionKey: "main" },
      expected: "main",
    },
    {
      name: "the configured main alias",
      params: {
        config: { ...singleAgentConfig, session: { mainKey: "inbox" } },
        sessionKey: "inbox",
      },
      expected: "main",
    },
  ])("binds $name", ({ params, expected }) => {
    expect(resolveBoundAgentIdForSession(params)).toBe(expected);
  });

  it("binds a bare global key to the persisted fixed-store owner", () => {
    const config = {
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
      session: { scope: "global", store: "/tmp/openclaw-shared-sessions.sqlite" },
    } satisfies OpenClawConfig;

    expect(resolveBoundAgentIdForSession({ config, sessionKey: "global" })).toBe("ops");
  });

  it("does not grant default-agent authority to an arbitrary unscoped key", () => {
    expect(
      resolveBoundAgentIdForSession({ config: singleAgentConfig, sessionKey: "legacy-session" }),
    ).toBeUndefined();
    expect(
      resolveBoundAgentIdForSession({ config: multiAgentConfig, sessionKey: "legacy-session" }),
    ).toBeUndefined();
  });
});
