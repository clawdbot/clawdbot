// Dashboard title tests cover eligibility, routing, normalization, and guarded persistence.
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateConversationLabelWithFallback = vi.hoisted(() => vi.fn());
const resolveUtilityModelRefForAgent = vi.hoisted(() => vi.fn());
const updateSessionEntry = vi.hoisted(() => vi.fn());

vi.mock("../agents/utility-model.js", () => ({ resolveUtilityModelRefForAgent }));
vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({ updateSessionEntry }));

import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { maybeGenerateDashboardSessionTitle } from "./dashboard-session-title.js";

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

describe("maybeGenerateDashboardSessionTitle", () => {
  beforeEach(() => {
    generateConversationLabelWithFallback.mockReset();
    resolveUtilityModelRefForAgent.mockReset();
    updateSessionEntry.mockReset();
    generateConversationLabelWithFallback.mockResolvedValue("Release Planning");
    resolveUtilityModelRefForAgent.mockReturnValue("openai/gpt-5.6-luna");
    mockSessionUpdate(baseEntry);
  });

  it("generates and persists a dashboard display name", async () => {
    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(true);

    expect(resolveUtilityModelRefForAgent).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      primaryProvider: "openai",
      primaryModelRef: "openai/gpt-5.5",
    });
    expect(generateConversationLabelWithFallback).toHaveBeenCalledWith({
      userMessage: "Help me plan the release",
      prompt:
        "Generate a concise session title (3-6 words, max 60 characters) from the user's first message. Use the same language as the message. No emoji. Return only the title.",
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

  it("routes both attempts through the effective session model and auth profile", async () => {
    const entry = {
      ...baseEntry,
      providerOverride: "anthropic",
      modelOverride: "claude-fable-5",
      authProfileOverride: "work",
    };
    resolveUtilityModelRefForAgent.mockReturnValue("anthropic/claude-haiku-4-5@work");
    mockSessionUpdate(entry);

    await expect(maybeGenerateDashboardSessionTitle(titleParams(entry))).resolves.toBe(true);

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
      maybeGenerateDashboardSessionTitle({ ...titleParams(), cfg: profiledCfg }),
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

    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(true);

    expect(generateConversationLabelWithFallback).toHaveBeenCalledWith(
      expect.not.objectContaining({ utilityModelRef: expect.anything() }),
    );
  });

  it("treats creator attribution as metadata rather than an explicit title", async () => {
    const entry = { ...baseEntry, origin: { label: "Peter" } };
    mockSessionUpdate(entry);

    await expect(maybeGenerateDashboardSessionTitle(titleParams(entry))).resolves.toBe(true);

    expect(generateConversationLabelWithFallback).toHaveBeenCalledOnce();
  });

  it("keeps utility title prompt input on a UTF-16 boundary", async () => {
    await expect(
      maybeGenerateDashboardSessionTitle({
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

    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(true);

    const update = updateSessionEntry.mock.calls[0]?.[1];
    expect(await update?.({ ...baseEntry })).toEqual({ displayName: expected });
  });

  it("keeps persisted titles on a UTF-16 boundary", async () => {
    generateConversationLabelWithFallback.mockResolvedValue(`${"a".repeat(59)}🚀tail`);

    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(true);

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
    ["existing session history", { entry: { ...baseEntry, systemSent: true } }],
  ])("skips %s", async (_name, override) => {
    await expect(
      maybeGenerateDashboardSessionTitle({ ...titleParams(), ...override }),
    ).resolves.toBe(false);

    expect(generateConversationLabelWithFallback).not.toHaveBeenCalled();
    expect(updateSessionEntry).not.toHaveBeenCalled();
  });

  it("does not overwrite a name added while the model request is running", async () => {
    mockSessionUpdate({ ...baseEntry, label: "Manual title" });

    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(false);

    expect(generateConversationLabelWithFallback).toHaveBeenCalledOnce();
  });

  it("does not write into a reset session generation", async () => {
    mockSessionUpdate({ ...baseEntry, sessionId: "session-2" });

    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(false);

    expect(generateConversationLabelWithFallback).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent title requests for one session generation", async () => {
    let resolveLabel!: (value: string) => void;
    generateConversationLabelWithFallback.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveLabel = resolve;
      }),
    );

    const first = maybeGenerateDashboardSessionTitle(titleParams());
    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(false);
    resolveLabel("Release Planning");
    await expect(first).resolves.toBe(true);

    expect(generateConversationLabelWithFallback).toHaveBeenCalledOnce();
  });
});
