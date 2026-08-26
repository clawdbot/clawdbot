import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRequestedChatAgentId, validateChatSelectedAgent } from "./chat-origin-routing.js";

describe("chat session owner resolution", () => {
  it("uses configured fixed-store ownership for bare keys", () => {
    const cfg: OpenClawConfig = {
      session: { store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    expect(resolveRequestedChatAgentId({ cfg, requestedSessionKey: "global" })).toEqual({
      ok: true,
      agentId: "ops",
    });
  });

  it("returns the typed selection error for ownerless bare keys", () => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    };

    expect(resolveRequestedChatAgentId({ cfg, requestedSessionKey: "global" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("has no explicit owner") },
    });
  });

  it("preserves an inferred ACP runtime owner through chat session validation", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { default: true } } },
    };
    const requestedSessionKey = "agent:codex:acp:11111111-1111-4111-8111-111111111111";

    const requestedAgent = resolveRequestedChatAgentId({ cfg, requestedSessionKey });

    expect(requestedAgent).toEqual({ ok: true, agentId: "codex" });
    if (!requestedAgent.ok) {
      throw new Error("Expected the ACP session key to resolve its runtime owner");
    }
    expect(
      validateChatSelectedAgent({
        cfg,
        requestedSessionKey,
      }),
    ).toEqual({ ok: true, agentId: "codex" });
  });

  it("still rejects an explicitly selected unconfigured ACP runtime owner", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { default: true } } },
    };

    expect(
      resolveRequestedChatAgentId({
        cfg,
        requestedSessionKey: "agent:codex:acp:11111111-1111-4111-8111-111111111111",
        agentId: "codex",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: 'Unknown agent id "codex"' },
    });
    expect(
      validateChatSelectedAgent({
        cfg,
        requestedSessionKey: "agent:codex:acp:11111111-1111-4111-8111-111111111111",
        explicitAgentId: "codex",
      }),
    ).toEqual({ ok: false, error: 'Unknown agent id "codex"' });
  });

  it.each([
    ["ordinary configured owner", "agent:main:main"],
    ["configured ACP binding owner", "agent:main:acp:binding:slack:default:thread"],
  ])("preserves %s across chat session validation", (_name, requestedSessionKey) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { default: true } } },
    };
    const requestedAgent = resolveRequestedChatAgentId({
      cfg,
      requestedSessionKey,
      agentId: "main",
    });

    expect(requestedAgent).toEqual({ ok: true, agentId: "main" });
    if (!requestedAgent.ok) {
      throw new Error("Expected the configured chat session owner to resolve");
    }
    expect(
      validateChatSelectedAgent({
        cfg,
        requestedSessionKey,
        explicitAgentId: "main",
      }),
    ).toEqual({ ok: true, agentId: "main" });
  });
});
