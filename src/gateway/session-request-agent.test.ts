import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSessionEventAgentScope,
  resolveRequestedSessionAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "./session-request-agent.js";

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
    expect(tryResolveSessionCompatibilityOwnerAgentId(fixedStoreConfig("ops"), "global")).toBe(
      "ops",
    );
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

  it.each(["main", "primary"])(
    "validates fixed ownership after the explicit %s alias becomes global",
    (alias) => {
      const key = `agent:research:${alias}`;
      const cfg = fixedStoreConfig("ops");
      cfg.session = { ...cfg.session, scope: "global", mainKey: "primary" };
      for (const owner of ["ops", "retired"]) {
        cfg.agents!.defaults!.sessionStore!.agentId = owner;
        expect.soft(resolveRequestedSessionAgentId(cfg, key, "research")).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST" },
        });
      }
      expect(resolveRequestedSessionAgentId(cfg, key)).toEqual({ ok: true, agentId: "research" });
      cfg.agents!.defaults!.sessionStore!.agentId = "research";
      expect(resolveRequestedSessionAgentId(cfg, key, "research")).toEqual({
        ok: true,
        agentId: "research",
      });
      cfg.session.store = "/synthetic/{agentId}/sessions.sqlite";
      cfg.agents!.defaults!.sessionStore!.agentId = "ops";
      expect(resolveRequestedSessionAgentId(cfg, key, "research")).toEqual({
        ok: true,
        agentId: "research",
      });
    },
  );

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

    expect(tryResolveSessionCompatibilityOwnerAgentId(cfg, "global")).toBeUndefined();
    expect(resolveRequestedSessionAgentId(cfg, "global")).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: expect.stringContaining("has no explicit owner"),
      },
    });
  });

  it("returns typed ownership results for arbitrary bare keys before canonicalization", () => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    };

    expect(resolveRequestedSessionAgentId(cfg, "thread-1")).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("has no explicit owner") },
    });
    expect(resolveRequestedSessionAgentId(cfg, "thread-1", "research")).toEqual({
      ok: true,
      agentId: "research",
    });
  });

  it.each(["", "   ", "агент✨", "---"])(
    "rejects explicit unrepresentable agent id %j instead of selecting main",
    (agentId) => {
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      };

      expect(resolveRequestedSessionAgentId(cfg, "global", agentId)).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: `Unknown agent id "${agentId}"`,
        },
      });
    },
  );

  it("keeps retired agent-qualified history readable outside global scope", () => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    };

    expect(resolveRequestedSessionAgentId(cfg, "agent:retired:main")).toEqual({
      ok: true,
      agentId: "retired",
    });
    expect(
      resolveRequestedSessionAgentId(
        { ...cfg, session: { scope: "global" } },
        "agent:retired:main",
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  });
});

describe("session event agent scope", () => {
  it("separates configured, retired, legacy, and explicit event ownership", () => {
    expect(resolveSessionEventAgentScope(fixedStoreConfig("ops"), "global")).toEqual([
      undefined,
      "ops",
      "ops",
    ]);
    expect(resolveSessionEventAgentScope(fixedStoreConfig("retired"), "global")).toEqual([
      undefined,
      "retired",
      undefined,
    ]);
    expect(
      resolveSessionEventAgentScope({ agents: { entries: { main: { default: true } } } }, "global"),
    ).toEqual([undefined, "main", "main"]);
    expect(resolveSessionEventAgentScope(fixedStoreConfig("ops"), "global", "research")).toEqual([
      "research",
      "research",
      "ops",
    ]);
  });

  it("rejects conflicting qualified event identity without consulting fallbacks", () => {
    expect(
      resolveSessionEventAgentScope(fixedStoreConfig("ops"), "agent:research:main", "ops"),
    ).toBeNull();
    expect(resolveSessionEventAgentScope(fixedStoreConfig("ops"), "agent:research:main")).toEqual([
      undefined,
      "research",
      undefined,
    ]);
    expect(
      resolveSessionEventAgentScope(
        fixedStoreConfig("ops"),
        "agent:research:main",
        undefined,
        true,
      ),
    ).toEqual(["research", "research", undefined]);
    expect(
      resolveSessionEventAgentScope(fixedStoreConfig("ops"), "agent:retired:main", undefined, true),
    ).toEqual([undefined, "retired", undefined]);
  });
});
