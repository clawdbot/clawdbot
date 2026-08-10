import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";

function fixedStoreConfig(owner: string): OpenClawConfig {
  return {
    session: { store: "/tmp/shared.sqlite" },
    agents: {
      ownership: "explicit",
      defaults: { sessionStore: { agentId: owner } },
      entries: { ops: {}, research: {} },
    },
  };
}

describe("requested session agent ownership", () => {
  it("uses the configured persisted owner for a bare key", () => {
    expect(resolveRequestedSessionAgentId(fixedStoreConfig("ops"), "global")).toEqual({
      ok: true,
      agentId: "ops",
    });
  });

  it("rejects conflicting and retired persisted owners", () => {
    expect(resolveRequestedSessionAgentId(fixedStoreConfig("ops"), "global", "research").ok).toBe(
      false,
    );
    expect(resolveRequestedSessionAgentId(fixedStoreConfig("retired"), "global").ok).toBe(false);
  });

  it("uses a legacy compatibility owner for a bare key", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { ops: { default: true }, research: {} } },
    };

    expect(resolveRequestedSessionAgentId(cfg, "global")).toEqual({
      ok: true,
      agentId: "ops",
    });
  });

  it("returns a typed selection error for an ownerless bare key", () => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    };

    expect(resolveRequestedSessionAgentId(cfg, "global")).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: expect.stringContaining("has no explicit owner"),
      },
    });
  });
});
