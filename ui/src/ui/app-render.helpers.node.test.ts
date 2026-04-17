import { describe, expect, it, vi } from "vitest";
const {
  refreshChatMock,
  refreshChatAvatarMock,
  refreshSlashCommandsMock,
  loadChatHistoryMock,
  loadSessionsMock,
} = vi.hoisted(() => ({
  refreshChatMock: vi.fn(),
  refreshChatAvatarMock: vi.fn(),
  refreshSlashCommandsMock: vi.fn(),
  loadChatHistoryMock: vi.fn(),
  loadSessionsMock: vi.fn(),
}));

vi.mock("./app-chat.ts", () => ({
  refreshChat: refreshChatMock,
  refreshChatAvatar: refreshChatAvatarMock,
}));

vi.mock("./chat/slash-commands.ts", () => ({
  refreshSlashCommands: (...args: unknown[]) => refreshSlashCommandsMock(...args),
}));

vi.mock("./controllers/chat.ts", () => ({
  loadChatHistory: loadChatHistoryMock,
}));

vi.mock("./controllers/sessions.ts", () => ({
  loadSessions: loadSessionsMock,
}));

import {
  isCronSessionKey,
  parseSessionKey,
  resolveAssistantAttachmentAuthToken,
  resolveSessionOptionGroups,
  resolveSessionDisplayName,
  switchChatSession,
} from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
import type { SessionsListResult } from "./types.ts";

type SessionRow = SessionsListResult["sessions"][number];

function row(overrides: Partial<SessionRow> & { key: string }): SessionRow {
  return { kind: "direct", updatedAt: 0, ...overrides };
}

function labelsForSessionOptions(params: {
  sessionKey: string;
  sessions?: SessionRow[];
  agentsList?: AppViewState["agentsList"];
}) {
  const groups = resolveSessionOptionGroups(
    {
      sessionsHideCron: true,
      agentsList: params.agentsList ?? null,
    } as AppViewState,
    params.sessionKey,
    {
      ts: 0,
      path: "",
      count: params.sessions?.length ?? 0,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: params.sessions ?? [],
    },
  );
  return groups.flatMap((group) => group.options.map((option) => option.label));
}

/* ================================================================
 *  parseSessionKey – low-level key → type / fallback mapping
 * ================================================================ */

describe("parseSessionKey", () => {
  it("identifies main session (bare 'main')", () => {
    expect(parseSessionKey("main")).toEqual({ prefix: "", fallbackName: "Main Session" });
  });

  it("identifies main session (agent:main:main)", () => {
    expect(parseSessionKey("agent:main:main")).toEqual({
      prefix: "",
      fallbackName: "Main Session",
    });
  });

  it("identifies subagent sessions", () => {
    expect(parseSessionKey("agent:main:subagent:18abfefe-1fa6-43cb-8ba8-ebdc9b43e253")).toEqual({
      prefix: "Subagent:",
      fallbackName: "Subagent:",
    });
  });

  it("identifies cron sessions", () => {
    expect(parseSessionKey("agent:main:cron:daily-briefing-uuid")).toEqual({
      prefix: "Cron:",
      fallbackName: "Cron Job:",
    });
    expect(parseSessionKey("cron:daily-briefing-uuid")).toEqual({
      prefix: "Cron:",
      fallbackName: "Cron Job:",
    });
  });

  it("identifies direct chat with known channel", () => {
    expect(parseSessionKey("agent:main:bluebubbles:direct:+19257864429")).toEqual({
      prefix: "",
      fallbackName: "iMessage · +19257864429",
    });
  });

  it("identifies direct chat with telegram", () => {
    expect(parseSessionKey("agent:main:telegram:direct:user123")).toEqual({
      prefix: "",
      fallbackName: "Telegram · user123",
    });
  });

  it("identifies group chat with known channel", () => {
    expect(parseSessionKey("agent:main:discord:group:guild-chan")).toEqual({
      prefix: "",
      fallbackName: "Discord Group",
    });
  });

  it("capitalises unknown channels in direct/group patterns", () => {
    expect(parseSessionKey("agent:main:mychannel:direct:user1")).toEqual({
      prefix: "",
      fallbackName: "Mychannel · user1",
    });
  });

  it("identifies channel-prefixed legacy keys", () => {
    expect(parseSessionKey("bluebubbles:g-agent-main-bluebubbles-direct-+19257864429")).toEqual({
      prefix: "",
      fallbackName: "iMessage Session",
    });
    expect(parseSessionKey("discord:123:456")).toEqual({
      prefix: "",
      fallbackName: "Discord Session",
    });
  });

  it("handles bare channel name as key", () => {
    expect(parseSessionKey("telegram")).toEqual({
      prefix: "",
      fallbackName: "Telegram Session",
    });
  });

  it("returns raw key for unknown patterns", () => {
    expect(parseSessionKey("something-unknown")).toEqual({
      prefix: "",
      fallbackName: "something-unknown",
    });
  });
});

describe("resolveAssistantAttachmentAuthToken", () => {
  it("prefers the explicit gateway token when present", () => {
    expect(
      resolveAssistantAttachmentAuthToken({
        settings: { token: "session-token" } as AppViewState["settings"],
        password: "shared-password",
      }),
    ).toBe("session-token");
  });

  it("falls back to the shared password when token is blank", () => {
    expect(
      resolveAssistantAttachmentAuthToken({
        settings: { token: "   " } as AppViewState["settings"],
        password: "shared-password",
      }),
    ).toBe("shared-password");
  });

  it("returns null when neither auth secret is available", () => {
    expect(
      resolveAssistantAttachmentAuthToken({
        settings: { token: "" } as AppViewState["settings"],
        password: "   ",
      }),
    ).toBeNull();
  });
});

/* ================================================================
 *  resolveSessionDisplayName – full resolution with row data
 * ================================================================ */

describe("resolveSessionDisplayName", () => {
  // ── Key-only fallbacks (no row) ──────────────────

  it("returns 'Main Session' for agent:main:main key", () => {
    expect(resolveSessionDisplayName("agent:main:main")).toBe("Main Session");
  });

  it("returns 'Main Session' for bare 'main' key", () => {
    expect(resolveSessionDisplayName("main")).toBe("Main Session");
  });

  it("returns 'Subagent:' for subagent key without row", () => {
    expect(resolveSessionDisplayName("agent:main:subagent:abc-123")).toBe("Subagent:");
  });

  it("returns 'Cron Job:' for cron key without row", () => {
    expect(resolveSessionDisplayName("agent:main:cron:abc-123")).toBe("Cron Job:");
  });

  it("parses direct chat key with channel", () => {
    expect(resolveSessionDisplayName("agent:main:bluebubbles:direct:+19257864429")).toBe(
      "iMessage · +19257864429",
    );
  });

  it("parses channel-prefixed legacy key", () => {
    expect(resolveSessionDisplayName("discord:123:456")).toBe("Discord Session");
  });

  it("returns raw key for unknown patterns", () => {
    expect(resolveSessionDisplayName("something-custom")).toBe("something-custom");
  });

  // ── With row data (label / displayName) ──────────

  it("returns parsed fallback when row has no label or displayName", () => {
    expect(resolveSessionDisplayName("agent:main:main", row({ key: "agent:main:main" }))).toBe(
      "Main Session",
    );
  });

  it("returns parsed fallback when displayName matches key", () => {
    expect(resolveSessionDisplayName("mykey", row({ key: "mykey", displayName: "mykey" }))).toBe(
      "mykey",
    );
  });

  it("returns parsed fallback when label matches key", () => {
    expect(resolveSessionDisplayName("mykey", row({ key: "mykey", label: "mykey" }))).toBe("mykey");
  });

  it("uses label alone when available", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", label: "General" }),
      ),
    ).toBe("General");
  });

  it("falls back to displayName when label is absent", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", displayName: "My Chat" }),
      ),
    ).toBe("My Chat");
  });

  it("prefers label over displayName when both are present", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", displayName: "My Chat", label: "General" }),
      ),
    ).toBe("General");
  });

  it("ignores whitespace-only label and falls back to displayName", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", displayName: "My Chat", label: "   " }),
      ),
    ).toBe("My Chat");
  });

  it("uses parsed fallback when whitespace-only label and no displayName", () => {
    expect(
      resolveSessionDisplayName("discord:123:456", row({ key: "discord:123:456", label: "   " })),
    ).toBe("Discord Session");
  });

  it("trims label and displayName", () => {
    expect(resolveSessionDisplayName("k", row({ key: "k", label: "  General  " }))).toBe("General");
    expect(resolveSessionDisplayName("k", row({ key: "k", displayName: "  My Chat  " }))).toBe(
      "My Chat",
    );
  });

  // ── Type prefixes applied to labels / displayNames ──

  it("prefixes subagent label with Subagent:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:subagent:abc-123",
        row({ key: "agent:main:subagent:abc-123", label: "maintainer-v2" }),
      ),
    ).toBe("Subagent: maintainer-v2");
  });

  it("prefixes subagent displayName with Subagent:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:subagent:abc-123",
        row({ key: "agent:main:subagent:abc-123", displayName: "Task Runner" }),
      ),
    ).toBe("Subagent: Task Runner");
  });

  it("prefixes cron label with Cron:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:cron:abc-123",
        row({ key: "agent:main:cron:abc-123", label: "daily-briefing" }),
      ),
    ).toBe("Cron: daily-briefing");
  });

  it("prefixes cron displayName with Cron:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:cron:abc-123",
        row({ key: "agent:main:cron:abc-123", displayName: "Nightly Sync" }),
      ),
    ).toBe("Cron: Nightly Sync");
  });

  it("does not double-prefix cron labels that already include Cron:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:cron:abc-123",
        row({ key: "agent:main:cron:abc-123", label: "Cron: Nightly Sync" }),
      ),
    ).toBe("Cron: Nightly Sync");
  });

  it("does not double-prefix subagent display names that already include Subagent:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:subagent:abc-123",
        row({ key: "agent:main:subagent:abc-123", displayName: "Subagent: Runner" }),
      ),
    ).toBe("Subagent: Runner");
  });

  it("does not prefix non-typed sessions with labels", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:bluebubbles:direct:+19257864429",
        row({ key: "agent:main:bluebubbles:direct:+19257864429", label: "Tyler" }),
      ),
    ).toBe("Tyler");
  });
});

describe("isCronSessionKey", () => {
  it("returns true for cron: prefixed keys", () => {
    expect(isCronSessionKey("cron:abc-123")).toBe(true);
    expect(isCronSessionKey("cron:weekly-agent-roundtable")).toBe(true);
    expect(isCronSessionKey("agent:main:cron:abc-123")).toBe(true);
    expect(isCronSessionKey("agent:main:cron:abc-123:run:run-1")).toBe(true);
  });

  it("returns false for non-cron keys", () => {
    expect(isCronSessionKey("main")).toBe(false);
    expect(isCronSessionKey("discord:group:eng")).toBe(false);
    expect(isCronSessionKey("agent:main:slack:cron:job:run:uuid")).toBe(false);
  });
});

describe("resolveSessionOptionGroups", () => {
  it("prefers grouped session labels over display names", () => {
    const sessionKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";
    const labels = labelsForSessionOptions({
      sessionKey,
      sessions: [
        row({
          key: sessionKey,
          label: "cron-config-check",
          displayName: "webchat:g-agent-main-subagent-4f2146de-887b-4176-9abe-91140082959b",
        }),
      ],
    });

    expect(labels).toContain("Subagent: cron-config-check");
    expect(labels).not.toContain(sessionKey);
    expect(labels).not.toContain(
      "subagent:4f2146de-887b-4176-9abe-91140082959b · webchat:g-agent-main-subagent-4f2146de-887b-4176-9abe-91140082959b",
    );
  });

  it("keeps scoped fallbacks for active grouped sessions without useful row metadata", () => {
    const sessionKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";

    expect(labelsForSessionOptions({ sessionKey })).toContain(
      "subagent:4f2146de-887b-4176-9abe-91140082959b",
    );
    expect(
      labelsForSessionOptions({
        sessionKey,
        sessions: [row({ key: sessionKey })],
      }),
    ).toContain("subagent:4f2146de-887b-4176-9abe-91140082959b");
  });

  it("disambiguates duplicate grouped labels with scoped suffixes", () => {
    const labels = labelsForSessionOptions({
      sessionKey: "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b",
      sessions: [
        row({
          key: "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b",
          label: "cron-config-check",
        }),
        row({
          key: "agent:main:subagent:6fb8b84b-c31f-410f-b7df-1553c82e43c9",
          label: "cron-config-check",
        }),
      ],
    });

    expect(labels).toContain(
      "Subagent: cron-config-check · subagent:4f2146de-887b-4176-9abe-91140082959b",
    );
    expect(labels).toContain(
      "Subagent: cron-config-check · subagent:6fb8b84b-c31f-410f-b7df-1553c82e43c9",
    );
    expect(labels).not.toContain("Subagent: cron-config-check");
  });

  it("uses agent group labels to keep duplicate main sessions unique", () => {
    const labels = labelsForSessionOptions({
      sessionKey: "agent:alpha:main",
      agentsList: {
        defaultId: "alpha",
        mainKey: "agent:alpha:main",
        scope: "all",
        agents: [
          { id: "alpha", name: "Deep Chat" },
          { id: "beta", name: "Coding" },
        ],
      },
      sessions: [
        row({ key: "agent:alpha:main" }),
        row({ key: "agent:beta:main" }),
        row({
          key: "agent:alpha:named-main",
          label: "Deep Chat (alpha) / main",
        }),
      ],
    });

    expect(labels.filter((label) => label === "Deep Chat (alpha) / main")).toHaveLength(1);
    expect(labels).toContain("Deep Chat (alpha) / main · named-main");
    expect(labels).toContain("Coding (beta) / main");
    expect(labels).not.toContain("main");
  });
});

describe("switchChatSession", () => {
  it("refreshes the chat avatar after clearing session-scoped state", async () => {
    const settings: AppViewState["settings"] = {
      gatewayUrl: "",
      token: "",
      locale: "en",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "dark",
      splitRatio: 0.6,
      navWidth: 280,
      navCollapsed: false,
      navGroupsCollapsed: {},
      borderRadius: 50,
      chatFocusMode: false,
      chatShowThinking: false,
      chatShowToolCalls: true,
    };
    const state = {
      sessionKey: "main",
      chatMessage: "draft",
      chatAttachments: [{ mimeType: "image/png", dataUrl: "data:image/png;base64,AAA" }],
      chatMessages: [{ role: "assistant", content: "old" }],
      chatToolMessages: [{ id: "tool-1" }],
      chatStreamSegments: [{ text: "segment", ts: 1 }],
      chatThinkingLevel: "high",
      chatStream: "stream",
      chatSideResult: {
        kind: "btw",
        runId: "btw-run-1",
        sessionKey: "main",
        question: "what changed?",
        text: "draft answer",
        isError: false,
        ts: 1,
      },
      lastError: "oops",
      compactionStatus: { phase: "active" },
      fallbackStatus: { phase: "active" },
      chatAvatarUrl: "/avatar/old",
      chatQueue: [{ id: "queued" }],
      chatRunId: "run-1",
      chatSideResultTerminalRuns: new Set(["btw-run-1"]),
      chatStreamStartedAt: 1,
      settings,
      applySettings(next: typeof settings) {
        state.settings = next;
      },
      loadAssistantIdentity: vi.fn(),
      resetToolStream: vi.fn(),
      resetChatScroll: vi.fn(),
    } as unknown as AppViewState;

    refreshChatAvatarMock.mockResolvedValue(undefined);
    refreshSlashCommandsMock.mockResolvedValue(undefined);
    loadChatHistoryMock.mockResolvedValue(undefined);
    loadSessionsMock.mockResolvedValue(undefined);

    switchChatSession(state, "agent:main:test-b");
    await Promise.resolve();

    expect(state.chatSideResult).toBeNull();
    expect(state.chatSideResultTerminalRuns.size).toBe(0);
    expect(refreshChatAvatarMock).toHaveBeenCalledWith(state);
    expect(refreshSlashCommandsMock).toHaveBeenCalledWith({
      client: undefined,
      agentId: "main",
    });
    expect(loadChatHistoryMock).toHaveBeenCalledWith(state);
    expect(loadSessionsMock).toHaveBeenCalledWith(state, {
      activeMinutes: 0,
      limit: 0,
      includeGlobal: true,
      includeUnknown: true,
    });
  });

  it("does not force agentId=main for plain session keys", async () => {
    const settings: AppViewState["settings"] = {
      gatewayUrl: "",
      token: "",
      locale: "en",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "dark",
      splitRatio: 0.6,
      navWidth: 280,
      navCollapsed: false,
      navGroupsCollapsed: {},
      borderRadius: 50,
      chatFocusMode: false,
      chatShowThinking: false,
      chatShowToolCalls: true,
    };
    const state = {
      sessionKey: "main",
      chatMessage: "",
      chatAttachments: [],
      chatMessages: [],
      chatToolMessages: [],
      chatStreamSegments: [],
      chatThinkingLevel: null,
      chatStream: null,
      chatSideResult: null,
      lastError: null,
      compactionStatus: null,
      fallbackStatus: null,
      chatAvatarUrl: null,
      chatQueue: [],
      chatRunId: null,
      chatSideResultTerminalRuns: new Set<string>(),
      chatStreamStartedAt: null,
      settings,
      applySettings(next: typeof settings) {
        state.settings = next;
      },
      loadAssistantIdentity: vi.fn(),
      resetToolStream: vi.fn(),
      resetChatScroll: vi.fn(),
      client: { request: vi.fn() },
    } as unknown as AppViewState;

    refreshChatAvatarMock.mockResolvedValue(undefined);
    refreshSlashCommandsMock.mockResolvedValue(undefined);
    loadChatHistoryMock.mockResolvedValue(undefined);
    loadSessionsMock.mockResolvedValue(undefined);

    switchChatSession(state, "main");
    await Promise.resolve();

    expect(refreshSlashCommandsMock).toHaveBeenCalledWith({
      client: state.client,
      agentId: undefined,
    });
  });
});
