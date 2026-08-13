import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveBoundAgentIdForSession } from "./session-agent-binding.js";

describe("resolveBoundAgentIdForSession", () => {
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
    const config = {
      agents: { entries: { main: {}, research: {} } },
    } satisfies OpenClawConfig;

    expect(resolveBoundAgentIdForSession({ config, sessionKey: "legacy-session" })).toBeUndefined();
  });
});
