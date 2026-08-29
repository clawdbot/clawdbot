// Dashboard title tests cover eligibility, routing, normalization, and guarded persistence.
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateConversationLabelWithFallback = vi.hoisted(() => vi.fn());
const resolveUtilityModelRefForAgent = vi.hoisted(() => vi.fn());
const readSessionTitleFieldsFromTranscript = vi.hoisted(() => vi.fn());
const updateSessionEntry = vi.hoisted(() => vi.fn());

vi.mock("../agents/utility-model.js", () => ({ resolveUtilityModelRefForAgent }));
vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({ updateSessionEntry }));
vi.mock("./session-transcript-title-reader.js", () => ({ readSessionTitleFieldsFromTranscript }));

import type { InternalSessionEntry, SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChatAttachment } from "./chat-attachments.js";
import {
  buildDashboardSessionTitleSource,
  maybeGenerateChatSessionTitle,
} from "./dashboard-session-title.js";

const cfg = {
  agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
} as OpenClawConfig;
const baseEntry: SessionEntry = {
  sessionId: "session-1",
  updatedAt: 1,
};

function titleParams(entry: SessionEntry | undefined = baseEntry) {
  return {
    cfg,
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

describe("maybeGenerateChatSessionTitle", () => {
  beforeEach(() => {
    generateConversationLabelWithFallback.mockReset();
    resolveUtilityModelRefForAgent.mockReset();
    updateSessionEntry.mockReset();
    readSessionTitleFieldsFromTranscript.mockReset();
    readSessionTitleFieldsFromTranscript.mockReturnValue({
      firstUserMessage: null,
      lastMessagePreview: null,
    });
    generateConversationLabelWithFallback.mockResolvedValue("Release Planning");
    resolveUtilityModelRefForAgent.mockReturnValue("openai/gpt-5.6-luna");
    mockSessionUpdate(baseEntry);
  });

  it("generates and persists a dashboard display name", async () => {
    await expect(maybeGenerateChatSessionTitle(titleParams())).resolves.toBe(true);

    expect(resolveUtilityModelRefForAgent).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      primaryProvider: "openai",
      primaryModelRef: "openai/gpt-5.5",
    });
    expect(generateConversationLabelWithFallback).toHaveBeenCalledWith({
      userMessage: "Help me plan the release",
      prompt:
        "Generate a concise session title (3-6 words, max 60 characters) from the user's first message. Use the same language as the message, in sentence case: capitalize only the first word and words that language always capitalizes. No emoji. Return only the title.",
      cfg,
      agentId: "main",
      utilityModelRef: "openai/gpt-5.6-luna",
      regularModelRef: "openai/gpt-5.5",
      normalizeLabel: expect.any(Function),
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
    expect(await update?.({ ...baseEntry })).toEqual({ displayName: "Release Planning" });
  });

  it.each(["bound", "pending"] as const)(
    "titles a non-dashboard session with a %s worktree",
    async (state) => {
      const entry: InternalSessionEntry = {
        ...baseEntry,
        ...(state === "pending"
          ? { pendingWorktree: { workspace: "/repo" } }
          : {
              worktree: {
                id: "worktree-title",
                branch: "openclaw/brisk-lobster",
                repoRoot: "/repo",
              },
            }),
      };
      mockSessionUpdate(entry);

      await expect(
        maybeGenerateChatSessionTitle({
          ...titleParams(entry),
          sessionKey: "agent:main:subagent:worktree-title",
        }),
      ).resolves.toBe(true);
      expect(generateConversationLabelWithFallback).toHaveBeenCalledOnce();
    },
  );

  it("routes both attempts through the effective session model and auth profile", async () => {
    const entry = {
      ...baseEntry,
      providerOverride: "anthropic",
      modelOverride: "claude-fable-5",
      authProfileOverride: "work",
    };
    resolveUtilityModelRefForAgent.mockReturnValue("anthropic/claude-haiku-4-5@work");
    mockSessionUpdate(entry);

    await expect(maybeGenerateChatSessionTitle(titleParams(entry))).resolves.toBe(true);

    expect(resolveUtilityModelRefForAgent).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      primaryProvider: "anthropic",
      primaryModelRef: "anthropic/claude-fable-5@work",
    });
    expect(generateConversationLabelWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        utilityModelRef: "anthropic/claude-haiku-4-5@work",
        regularModelRef: "anthropic/claude-fable-5@work",
        preferredProfile: "work",
      }),
    );
  });

  it("preserves a locked session harness as the title runtime owner", async () => {
    const entry = {
      ...baseEntry,
      agentHarnessId: "codex",
      agentRuntimeOverride: "openclaw",
      modelSelectionLocked: true,
    };
    mockSessionUpdate(entry);

    await expect(maybeGenerateChatSessionTitle(titleParams(entry))).resolves.toBe(true);

    expect(generateConversationLabelWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({ agentHarnessRuntimeOverride: "codex" }),
    );
  });

  it("preserves a compatible session runtime override for title generation", async () => {
    const entry = {
      ...baseEntry,
      providerOverride: "anthropic",
      modelOverride: "claude-fable-5",
      agentRuntimeOverride: "claude-cli",
    };
    mockSessionUpdate(entry);

    await expect(maybeGenerateChatSessionTitle(titleParams(entry))).resolves.toBe(true);

    expect(generateConversationLabelWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({ agentHarnessRuntimeOverride: "claude-cli" }),
    );
  });

  it("preserves the configured primary auth profile for explicit utility models", async () => {
    const profiledCfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5@personal" },
          utilityModel: "openai/gpt-5.6-luna",
        },
      },
    } as OpenClawConfig;
    resolveUtilityModelRefForAgent.mockReturnValue("openai/gpt-5.6-luna");

    await expect(
      maybeGenerateChatSessionTitle({ ...titleParams(), cfg: profiledCfg }),
    ).resolves.toBe(true);

    expect(generateConversationLabelWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        utilityModelRef: "openai/gpt-5.6-luna",
        regularModelRef: "openai/gpt-5.5@personal",
        preferredProfile: "personal",
      }),
    );
  });

  it("goes directly to the regular model when utility routing is disabled", async () => {
    resolveUtilityModelRefForAgent.mockReturnValue(undefined);

    await expect(maybeGenerateChatSessionTitle(titleParams())).resolves.toBe(true);

    expect(generateConversationLabelWithFallback).toHaveBeenCalledWith(
      expect.not.objectContaining({ utilityModelRef: expect.anything() }),
    );
  });

  it("treats creator attribution as metadata rather than an explicit title", async () => {
    const entry = { ...baseEntry, origin: { label: "Peter" } };
    mockSessionUpdate(entry);

    await expect(maybeGenerateChatSessionTitle(titleParams(entry))).resolves.toBe(true);

    expect(generateConversationLabelWithFallback).toHaveBeenCalledOnce();
  });

  it("keeps utility title prompt input on a UTF-16 boundary", async () => {
    await expect(
      maybeGenerateChatSessionTitle({
        ...titleParams(),
        userMessage: `${"m".repeat(999)}🚀tail`,
      }),
    ).resolves.toBe(true);

    expect(generateConversationLabelWithFallback.mock.calls[0]?.[0]?.userMessage).toBe(
      "m".repeat(999),
    );
  });

  it.each([
    ['```text\n"Release Planning"\n```', "Release Planning"],
    ["Title:  Release   planning ", "Release planning"],
  ])("normalizes generated title wrappers", async (generated, expected) => {
    generateConversationLabelWithFallback.mockResolvedValue(generated);

    await expect(maybeGenerateChatSessionTitle(titleParams())).resolves.toBe(true);

    const update = updateSessionEntry.mock.calls[0]?.[1];
    expect(await update?.({ ...baseEntry })).toEqual({ displayName: expected });
  });

  it("keeps persisted titles on a UTF-16 boundary", async () => {
    generateConversationLabelWithFallback.mockResolvedValue(`${"a".repeat(59)}🚀tail`);

    await expect(maybeGenerateChatSessionTitle(titleParams())).resolves.toBe(true);

    const update = updateSessionEntry.mock.calls[0]?.[1];
    expect(await update?.({ ...baseEntry })).toEqual({ displayName: "a".repeat(59) });
  });

  it.each([
    ["non-dashboard session", { sessionKey: "agent:main:main" }],
    ["slash command", { userMessage: "/status" }],
    ["manual label", { entry: { ...baseEntry, label: "My release" } }],
    ["persisted display name", { entry: { ...baseEntry, displayName: "My release" } }],
    ["group subject", { entry: { ...baseEntry, subject: "Release team" } }],
    ["channel name", { entry: { ...baseEntry, groupChannel: "releases" } }],
    ["space name", { entry: { ...baseEntry, space: "Engineering" } }],
  ])("skips %s", async (_name, override) => {
    await expect(maybeGenerateChatSessionTitle({ ...titleParams(), ...override })).resolves.toBe(
      false,
    );

    expect(generateConversationLabelWithFallback).not.toHaveBeenCalled();
    expect(updateSessionEntry).not.toHaveBeenCalled();
  });

  it("retries a historical session from the transcript's first user message", async () => {
    const entry = { ...baseEntry, systemSent: true };
    readSessionTitleFieldsFromTranscript.mockReturnValue({
      firstUserMessage: "[Mon 2026-08-10 12:00 UTC] Original release plan",
      lastMessagePreview: "Latest follow-up",
    });
    mockSessionUpdate(entry);

    await expect(
      maybeGenerateChatSessionTitle({
        ...titleParams(entry),
        currentUserMessage: "Latest follow-up",
        userMessage: "Latest follow-up",
      }),
    ).resolves.toBe(true);

    expect(generateConversationLabelWithFallback.mock.calls[0]?.[0]?.userMessage).toBe(
      "Original release plan",
    );
  });

  it.each(["Fix the child deployment", ""])(
    "titles a forked chat from child input %j instead of copied parent history",
    async (currentUserMessage) => {
      const entry = {
        ...baseEntry,
        forkSource: { sessionKey: "agent:main:dashboard:parent", sessionId: "parent-session" },
      };
      readSessionTitleFieldsFromTranscript.mockReturnValue({
        firstUserMessage: "Plan the parent release",
        lastMessagePreview: "Fix the child deployment",
      });
      mockSessionUpdate(entry);

      await expect(
        maybeGenerateChatSessionTitle({
          ...titleParams(entry),
          currentUserMessage,
          userMessage: "Fix the child deployment\nAttached deployment details",
        }),
      ).resolves.toBe(true);

      expect(generateConversationLabelWithFallback.mock.calls[0]?.[0]?.userMessage).toBe(
        "Fix the child deployment\nAttached deployment details",
      );
    },
  );

  it("preserves attachment-aware input when the first turn is already in the transcript", async () => {
    readSessionTitleFieldsFromTranscript.mockReturnValue({
      firstUserMessage: "[Mon 2026-08-10 12:00 UTC] Review this rollout",
      lastMessagePreview: "Review this rollout",
    });

    await expect(
      maybeGenerateChatSessionTitle({
        ...titleParams(),
        currentUserMessage: "Review this rollout",
        userMessage: "Review this rollout\nDeployment context",
      }),
    ).resolves.toBe(true);

    expect(generateConversationLabelWithFallback.mock.calls[0]?.[0]?.userMessage).toBe(
      "Review this rollout\nDeployment context",
    );
  });

  it("evicts a failed request so later activity can retry", async () => {
    generateConversationLabelWithFallback
      .mockRejectedValueOnce(new Error("route unavailable"))
      .mockResolvedValueOnce("Release Planning");

    await expect(maybeGenerateChatSessionTitle(titleParams())).rejects.toThrow("route unavailable");
    await expect(maybeGenerateChatSessionTitle(titleParams())).resolves.toBe(true);
    expect(generateConversationLabelWithFallback).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite a name added while the model request is running", async () => {
    mockSessionUpdate({ ...baseEntry, label: "Manual title" });

    await expect(maybeGenerateChatSessionTitle(titleParams())).resolves.toBe(false);

    expect(generateConversationLabelWithFallback).toHaveBeenCalledOnce();
  });

  it("does not write into a reset session generation", async () => {
    mockSessionUpdate({ ...baseEntry, sessionId: "session-2" });

    await expect(maybeGenerateChatSessionTitle(titleParams())).resolves.toBe(false);

    expect(generateConversationLabelWithFallback).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent title requests for one session generation", async () => {
    let resolveLabel!: (value: string) => void;
    generateConversationLabelWithFallback.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveLabel = resolve;
      }),
    );

    const first = maybeGenerateChatSessionTitle(titleParams());
    await expect(maybeGenerateChatSessionTitle(titleParams())).resolves.toBe(false);
    resolveLabel("Release Planning");
    await expect(first).resolves.toBe(true);

    expect(generateConversationLabelWithFallback).toHaveBeenCalledOnce();
  });
});

describe("buildDashboardSessionTitleSource", () => {
  it("combines an ordinary command with large pasted text within the title-source cap", async () => {
    const pastedText = `Release details ${"x".repeat(2_000)}`;
    const source = buildDashboardSessionTitleSource({
      message: "Review this rollout [[reply_to_current]]",
      attachments: [textAttachment("Deployment context"), textAttachment(pastedText)],
    });
    expect(source).toBe(
      `Review this rollout [[reply_to_current]]\nDeployment context\n${pastedText}`.slice(0, 1_000),
    );
  });

  it.each([
    ["attachment-only", "", "Pasted migration checklist"],
    ["slash command with attachment", "/status", "Pasted incident report"],
  ])("titles an %s turn from its text attachment", async (_name, userMessage, text) => {
    expect(
      buildDashboardSessionTitleSource({
        message: userMessage,
        attachments: [textAttachment(text)],
      }),
    ).toBe(text);
  });

  it.each([
    ["malformed base64", { mimeType: "text/plain", content: "%%%" }],
    [
      "invalid UTF-8",
      { mimeType: "text/plain", content: Buffer.from([0xc3, 0x28]).toString("base64") },
    ],
    ["non-text", { mimeType: "image/png", content: Buffer.from("not text").toString("base64") }],
  ] satisfies Array<[string, ChatAttachment]>)(
    "ignores %s attachments",
    async (_name, attachment) =>
      expect(buildDashboardSessionTitleSource({ message: "", attachments: [attachment] })).toBe(""),
  );

  it("ignores a long text attachment with malformed trailing base64", async () => {
    const valid = Buffer.from("a".repeat(4_000)).toString("base64");
    const malformed = `${valid.slice(0, -4)}AAA%`;

    expect(
      buildDashboardSessionTitleSource({
        message: "",
        attachments: [{ mimeType: "text/plain", content: malformed }],
      }),
    ).toBe("");
  });

  it("keeps attachment-derived title input on a UTF-16 boundary", async () => {
    expect(
      buildDashboardSessionTitleSource({
        message: "",
        attachments: [textAttachment(`${"a".repeat(999)}🚀tail`)],
      }),
    ).toBe("a".repeat(999));
  });
});

function textAttachment(text: string): ChatAttachment {
  return {
    type: "file",
    mimeType: "text/plain",
    content: Buffer.from(text).toString("base64"),
  };
}
