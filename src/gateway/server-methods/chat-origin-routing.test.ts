import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { validateChatSelectedAgent } from "./chat-origin-routing.js";

describe("chat session owner resolution", () => {
  it("preserves an inferred ACP runtime owner through chat session validation", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { default: true } } },
    };
    const requestedSessionKey = "agent:codex:acp:11111111-1111-4111-8111-111111111111";

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
    expect(
      validateChatSelectedAgent({
        cfg,
        requestedSessionKey,
        explicitAgentId: "main",
      }),
    ).toEqual({ ok: true, agentId: "main" });
  });
});
