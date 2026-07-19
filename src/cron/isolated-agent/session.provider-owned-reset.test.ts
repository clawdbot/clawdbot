import { describe, expect, it } from "vitest";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronSession } from "./session.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = 1_737_600_000_000;

function providerOwnedEntry(): SessionEntry {
  const startedAt = NOW_MS - DAY_MS;
  return {
    sessionId: "old-session-id",
    updatedAt: startedAt,
    sessionStartedAt: startedAt,
    lastInteractionAt: startedAt,
    model: "claude-opus-4-6",
    modelProvider: "claude-cli",
    cliSessionBindings: { "claude-cli": { sessionId: "cli-conversation-xyz" } },
  };
}

describe("resolveCronSession provider-owned daily reset", () => {
  it("keeps a provider-owned CLI session with the default reset policy", () => {
    const sessionKey = "agent:main:cron:daily-job";
    const entry = providerOwnedEntry();

    const result = resolveCronSession({
      cfg: { session: {} } as OpenClawConfig,
      sessionKey,
      agentId: "main",
      nowMs: NOW_MS,
      forceNew: false,
      store: { [sessionKey]: entry },
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionEntry.sessionId).toBe("old-session-id");
    expect(getCliSessionBinding(result.sessionEntry, "claude-cli")).toEqual({
      sessionId: "cli-conversation-xyz",
    });
  });

  it("still rotates a non-provider-owned session across the daily boundary", () => {
    const sessionKey = "agent:main:cron:daily-job";
    const startedAt = NOW_MS - DAY_MS;
    const entry: SessionEntry = {
      sessionId: "old-session-id",
      updatedAt: startedAt,
      sessionStartedAt: startedAt,
      lastInteractionAt: startedAt,
    };

    const result = resolveCronSession({
      cfg: { session: { reset: { mode: "daily" } } } as OpenClawConfig,
      sessionKey,
      agentId: "main",
      nowMs: NOW_MS,
      forceNew: false,
      store: { [sessionKey]: entry },
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionEntry.sessionId).not.toBe("old-session-id");
  });

  it("still rotates a provider-owned session when reset is explicitly configured", () => {
    const sessionKey = "agent:main:cron:daily-job";
    const entry = providerOwnedEntry();

    const result = resolveCronSession({
      cfg: { session: { reset: { mode: "daily" } } } as OpenClawConfig,
      sessionKey,
      agentId: "main",
      nowMs: NOW_MS,
      forceNew: false,
      store: { [sessionKey]: entry },
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionEntry.sessionId).not.toBe("old-session-id");
    expect(getCliSessionBinding(result.sessionEntry, "claude-cli")).toBeUndefined();
  });
});
