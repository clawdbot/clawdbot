import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import { type ReplyExecOverrides, resolveReplyExecOverrides } from "./get-reply-exec-overrides.js";

const AGENT_EXEC_DEFAULTS = {
  host: "node",
  security: "allowlist",
  ask: "always",
  node: "worker-alpha",
} as const satisfies ReplyExecOverrides;

function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "main",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("reply exec overrides", () => {
  it("uses per-agent exec defaults when session and message are unset", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry: createSessionEntry(),
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual(AGENT_EXEC_DEFAULTS);
  });

  it("prefers inline exec directives, then persisted session overrides, then agent defaults", () => {
    const sessionEntry = createSessionEntry({
      execHost: "gateway",
      execSecurity: "deny",
    });

    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("/exec host=auto security=full"),
        sessionEntry,
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual({
      ...AGENT_EXEC_DEFAULTS,
      host: "auto",
      security: "full",
    });

    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry,
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual({
      ...AGENT_EXEC_DEFAULTS,
      host: "gateway",
      security: "deny",
    });
  });

  it("uses persisted session exec fields for later turns", () => {
    const sessionEntry = createSessionEntry({
      execHost: "gateway",
      execSecurity: "full",
      execAsk: "always",
    });

    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry,
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual({
      ...AGENT_EXEC_DEFAULTS,
      host: "gateway",
      security: "full",
      ask: "always",
    });
  });
});
