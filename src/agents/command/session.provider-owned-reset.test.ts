import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";

const hoisted = vi.hoisted(() => ({
  store: {} as Record<string, SessionEntry>,
  terminalTranscriptNewer: false,
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  listSessionEntries: () =>
    Object.entries(hoisted.store).map(([sessionKey, entry]) => ({
      sessionKey,
      entry,
    })),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: () => "/stores/main.json",
}));

vi.mock("../../config/sessions/lifecycle.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/lifecycle.js")>(
    "../../config/sessions/lifecycle.js",
  );
  return {
    ...actual,
    hasTerminalMainSessionTranscriptNewerThanRegistrySync: () => hoisted.terminalTranscriptNewer,
  };
});

const { resolveSession } = await import("./session.js");

const DAY_MS = 24 * 60 * 60 * 1000;

function seedProviderOwned(sessionKey: string): void {
  const startedAt = Date.now() - DAY_MS;
  hoisted.store = {
    [sessionKey]: {
      sessionId: "old-session-id",
      updatedAt: startedAt,
      sessionStartedAt: startedAt,
      lastInteractionAt: startedAt,
      model: "claude-opus-4-6",
      modelProvider: "claude-cli",
      cliSessionBindings: { "claude-cli": { sessionId: "cli-conversation-xyz" } },
    },
  };
}

describe("command resolveSession provider-owned daily reset", () => {
  beforeEach(() => {
    hoisted.terminalTranscriptNewer = false;
  });

  it("keeps a provider-owned CLI session with the default reset policy", () => {
    const sessionKey = "agent:main:cli";
    seedProviderOwned(sessionKey);

    const result = resolveSession({
      cfg: { session: {} } as OpenClawConfig,
      sessionKey,
      agentId: "main",
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe("old-session-id");
  });

  it("still rotates a non-provider-owned session across the daily boundary", () => {
    const sessionKey = "agent:main:cli";
    const startedAt = Date.now() - DAY_MS;
    hoisted.store = {
      [sessionKey]: {
        sessionId: "old-session-id",
        updatedAt: startedAt,
        sessionStartedAt: startedAt,
        lastInteractionAt: startedAt,
      },
    };

    const result = resolveSession({
      cfg: { session: { reset: { mode: "daily" } } } as OpenClawConfig,
      sessionKey,
      agentId: "main",
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe("old-session-id");
  });

  it("keeps a model-locked session across the daily boundary", () => {
    const sessionKey = "agent:main:codex-supervised";
    const startedAt = Date.now() - DAY_MS;
    hoisted.store = {
      [sessionKey]: {
        sessionId: "locked-session-id",
        updatedAt: startedAt,
        sessionStartedAt: startedAt,
        lastInteractionAt: startedAt,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    };
    hoisted.terminalTranscriptNewer = true;

    const result = resolveSession({
      cfg: { session: {} } as OpenClawConfig,
      sessionKey,
      agentId: "main",
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe("locked-session-id");
  });

  it("carries stored thinking and verbose preferences during terminal transcript recovery", () => {
    const sessionKey = "agent:main:cli";
    const now = Date.now();
    hoisted.store = {
      [sessionKey]: {
        sessionId: "recovering-session-id",
        updatedAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now,
        thinkingLevel: "high",
        verboseLevel: "full",
      },
    };
    hoisted.terminalTranscriptNewer = true;

    const result = resolveSession({
      cfg: { session: {} } as OpenClawConfig,
      sessionKey,
      agentId: "main",
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe("recovering-session-id");
    expect(result.persistedThinking).toBe("high");
    expect(result.persistedVerbose).toBe("full");
  });

  it("carries preferences across a daily reset", () => {
    const sessionKey = "agent:main:cli";
    const startedAt = Date.now() - 2 * DAY_MS;
    hoisted.store = {
      [sessionKey]: {
        sessionId: "daily-expired-session-id",
        updatedAt: startedAt,
        sessionStartedAt: startedAt,
        lastInteractionAt: startedAt,
        thinkingLevel: "high",
        verboseLevel: "full",
      },
    };
    const result = resolveSession({
      cfg: { session: { reset: { mode: "daily" } } } as OpenClawConfig,
      sessionKey,
      agentId: "main",
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe("daily-expired-session-id");
    expect(result.persistedThinking).toBe("high");
    expect(result.persistedVerbose).toBe("full");
  });

  it("carries preferences when terminal recovery overlaps an idle reset", () => {
    const sessionKey = "agent:main:cli";
    const now = Date.now();
    const lastInteractionAt = now - 60 * 60 * 1000;
    hoisted.store = {
      [sessionKey]: {
        sessionId: "idle-expired-session-id",
        updatedAt: lastInteractionAt,
        sessionStartedAt: now,
        lastInteractionAt,
        thinkingLevel: "high",
        verboseLevel: "on",
      },
    };
    hoisted.terminalTranscriptNewer = true;

    const result = resolveSession({
      cfg: {
        session: {
          reset: { mode: "idle", idleMinutes: 30 },
        },
      } as OpenClawConfig,
      sessionKey,
      agentId: "main",
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe("idle-expired-session-id");
    expect(result.persistedThinking).toBe("high");
    expect(result.persistedVerbose).toBe("on");
  });
});
