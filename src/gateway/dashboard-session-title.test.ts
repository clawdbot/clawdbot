// Dashboard title tests cover eligibility, normalization, and guarded persistence.
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateConversationLabel = vi.hoisted(() => vi.fn());
const updateSessionEntry = vi.hoisted(() => vi.fn());

vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabel,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({ updateSessionEntry }));

import type { SessionEntry } from "../config/sessions/types.js";
import { maybeGenerateDashboardSessionTitle } from "./dashboard-session-title.js";

const baseEntry: SessionEntry = {
  sessionId: "session-1",
  updatedAt: 1,
};

function titleParams(entry: SessionEntry | undefined = baseEntry) {
  return {
    cfg: {},
    agentId: "main",
    entry,
    sessionId: "session-1",
    sessionKey: "agent:main:dashboard:chat-1",
    storePath: "/tmp/openclaw/sessions.json",
    userMessage: "Help me plan the release",
  };
}

function mockSessionUpdate(current: SessionEntry): void {
  updateSessionEntry.mockImplementation(async (_scope, update) => {
    const patch = await update({ ...current });
    return patch ? { ...current, ...patch } : current;
  });
}

describe("maybeGenerateDashboardSessionTitle", () => {
  beforeEach(() => {
    generateConversationLabel.mockReset();
    updateSessionEntry.mockReset();
    generateConversationLabel.mockResolvedValue("Release Planning");
    mockSessionUpdate(baseEntry);
  });

  it("generates and persists a dashboard display name", async () => {
    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(true);

    expect(generateConversationLabel).toHaveBeenCalledWith({
      userMessage: "Help me plan the release",
      prompt:
        "Generate a concise session title (3-6 words, max 60 characters) from the user's first message. Use the same language as the message. No emoji. Return only the title.",
      cfg: {},
      agentId: "main",
      maxLength: 60,
    });
    expect(updateSessionEntry).toHaveBeenCalledWith(
      {
        agentId: "main",
        sessionKey: "agent:main:dashboard:chat-1",
        storePath: "/tmp/openclaw/sessions.json",
      },
      expect.any(Function),
      { requireWriteSuccess: true },
    );
    const update = updateSessionEntry.mock.calls[0]?.[1];
    expect(await update?.({ ...baseEntry })).toEqual({
      displayName: "Release Planning",
    });
  });

  it("keeps utility title prompt input on a UTF-16 boundary", async () => {
    await expect(
      maybeGenerateDashboardSessionTitle({
        ...titleParams(),
        userMessage: `${"m".repeat(999)}🚀tail`,
      }),
    ).resolves.toBe(true);

    expect(generateConversationLabel.mock.calls[0]?.[0]?.userMessage).toBe("m".repeat(999));
  });

  it.each([
    ['```text\n"Release Planning"\n```', "Release Planning"],
    ["Title:  Release   planning ", "Release planning"],
  ])("normalizes generated title wrappers", async (generated, expected) => {
    generateConversationLabel.mockResolvedValue(generated);

    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(true);

    const update = updateSessionEntry.mock.calls[0]?.[1];
    expect(await update?.({ ...baseEntry })).toEqual({ displayName: expected });
  });

  it("keeps persisted titles on a UTF-16 boundary", async () => {
    generateConversationLabel.mockResolvedValue(`${"a".repeat(59)}🚀tail`);

    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(true);

    const update = updateSessionEntry.mock.calls[0]?.[1];
    expect(await update?.({ ...baseEntry })).toEqual({ displayName: "a".repeat(59) });
  });

  it.each([
    ["non-dashboard session", { sessionKey: "agent:main:main" }],
    ["slash command", { userMessage: "/status" }],
    ["manual label", { entry: { ...baseEntry, label: "My release" } }],
    ["manual display name", { entry: { ...baseEntry, displayName: "My release" } }],
    ["existing session history", { entry: { ...baseEntry, systemSent: true } }],
  ])("skips %s", async (_name, override) => {
    await expect(
      maybeGenerateDashboardSessionTitle({ ...titleParams(), ...override }),
    ).resolves.toBe(false);

    expect(generateConversationLabel).not.toHaveBeenCalled();
    expect(updateSessionEntry).not.toHaveBeenCalled();
  });

  it("does not overwrite a name added while the model request is running", async () => {
    mockSessionUpdate({ ...baseEntry, label: "Manual title" });

    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(false);

    expect(generateConversationLabel).toHaveBeenCalledOnce();
  });

  it("does not write into a reset session generation", async () => {
    mockSessionUpdate({ ...baseEntry, sessionId: "session-2" });

    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(false);

    expect(generateConversationLabel).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent title requests for one session generation", async () => {
    let resolveLabel!: (value: string) => void;
    generateConversationLabel.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveLabel = resolve;
      }),
    );

    const first = maybeGenerateDashboardSessionTitle(titleParams());
    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(false);
    resolveLabel("Release Planning");
    await expect(first).resolves.toBe(true);

    expect(generateConversationLabel).toHaveBeenCalledOnce();
  });
});
