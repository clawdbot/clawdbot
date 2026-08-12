// Tests execution override directives passed through get-reply.
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";
import {
  type ReplyExecOverrides,
  resolveConfigExecDefaults,
  resolveReplyExecOverrides,
} from "./get-reply-exec-overrides.js";

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
        directives: parseInlineSessionDirectives("run a command"),
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
        directives: parseInlineSessionDirectives("/exec host=auto security=full"),
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
        directives: parseInlineSessionDirectives("run a command"),
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
        directives: parseInlineSessionDirectives("run a command"),
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

  it("carries the node cwd separately from the Gateway workspace", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineSessionDirectives("run a command"),
        sessionEntry: createSessionEntry({
          execHost: "node",
          execNode: "macbook",
          execCwd: "/Users/peter/Projects/openclaw",
        }),
      }),
    ).toEqual({
      host: "node",
      security: undefined,
      ask: undefined,
      node: "macbook",
      nodeCwd: "/Users/peter/Projects/openclaw",
    });
  });

  it("does not carry a stored cwd across an inline node override", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineSessionDirectives("/exec node=other-node"),
        sessionEntry: createSessionEntry({
          execHost: "node",
          execNode: "macbook",
          execCwd: "/Users/peter/Projects/openclaw",
        }),
      }),
    ).toEqual({
      host: "node",
      security: undefined,
      ask: undefined,
      node: "other-node",
    });
  });

  it("carries agentExecDefaults.mode into the resolved overrides when nothing else sets policy", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineSessionDirectives("run a command"),
        sessionEntry: createSessionEntry(),
        agentExecDefaults: {
          host: "gateway",
          mode: "auto",
          security: "allowlist",
          ask: "on-miss",
        },
      }),
    ).toEqual({
      host: "gateway",
      mode: "auto",
      security: "allowlist",
      ask: "on-miss",
    });
  });

  it("drops the config-derived mode once a session or inline security/ask override applies", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineSessionDirectives("run a command"),
        sessionEntry: createSessionEntry({ execSecurity: "deny" }),
        agentExecDefaults: {
          host: "gateway",
          mode: "auto",
          security: "allowlist",
          ask: "on-miss",
        },
      }),
    ).toEqual({
      host: "gateway",
      security: "deny",
      ask: "on-miss",
    });
  });
});

describe("resolveConfigExecDefaults", () => {
  it("inherits the persistent global tools.exec policy for a fresh session (#112376)", () => {
    const cfg: OpenClawConfig = {
      tools: {
        exec: {
          host: "gateway",
          security: "full",
          ask: "off",
        },
      },
    };

    expect(resolveConfigExecDefaults({ cfg })).toEqual({
      host: "gateway",
      security: "full",
      ask: "off",
      node: undefined,
    });
  });

  it("lets a per-agent tools.exec override win over the global policy", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            tools: { exec: { security: "full", ask: "off" } },
          },
        ],
      },
      tools: {
        exec: {
          host: "gateway",
          security: "deny",
        },
      },
    };

    const resolved = resolveConfigExecDefaults({ cfg, agentId: "main" });
    expect(resolved?.security).toBe("full");
    expect(resolved?.ask).toBe("off");
  });

  it("surfaces a configured exec mode alongside its derived security/ask", () => {
    const cfg: OpenClawConfig = {
      tools: {
        exec: {
          mode: "auto",
        },
      },
    };

    expect(resolveConfigExecDefaults({ cfg })).toEqual({
      host: undefined,
      mode: "auto",
      security: "allowlist",
      ask: "on-miss",
      node: undefined,
    });
  });

  it("returns undefined when no exec policy is configured anywhere", () => {
    expect(resolveConfigExecDefaults({ cfg: {} })).toBeUndefined();
  });
});
