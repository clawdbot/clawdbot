/**
 * Tests command status runtime lazy loading and direct status reply behavior.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const buildStatusReply = vi.fn(async (params: unknown) => params);
const loadSessionEntry = vi.fn();
const resolveSessionAgentId = vi.fn();
const resolveAgentConfig = vi.fn();
const listAgentEntries = vi.fn();
const resolveDefaultModelForAgent = vi.fn();
const resolveDefaultModel = vi.fn();
const createModelSelectionState = vi.fn();
const resolveCurrentDirectiveLevels = vi.fn();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../auto-reply/reply/commands-status.js", () => ({
  buildStatusReply,
}));

vi.mock("../gateway/session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: loadSessionEntry,
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentEntries,
  resolveAgentConfig,
  resolveSessionAgentId,
}));

vi.mock("../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent,
}));

vi.mock("../auto-reply/reply/directive-handling.defaults.js", () => ({
  resolveDefaultModel,
}));

vi.mock("../auto-reply/reply/model-selection.js", () => ({
  createModelSelectionState,
}));

vi.mock("../auto-reply/reply/directive-handling.levels.js", () => ({
  resolveCurrentDirectiveLevels,
}));

const { resolveDirectStatusReplyForSessionCore } = await import("./command-status.runtime.js");

function expectResolvedReasoningLevel(value: unknown, expected: string) {
  expect((value as { resolvedReasoningLevel?: unknown }).resolvedReasoningLevel).toBe(expected);
}

function requireBuildStatusReplyParams(index = 0): unknown {
  const call = buildStatusReply.mock.calls[index];
  if (!call) {
    throw new Error(`expected buildStatusReply call ${index}`);
  }
  return call[0];
}

describe("resolveDirectStatusReplyForSessionCore", () => {
  beforeEach(() => {
    buildStatusReply.mockReset();
    loadSessionEntry.mockReset();
    resolveSessionAgentId.mockReset();
    resolveAgentConfig.mockReset();
    listAgentEntries.mockReset();
    resolveDefaultModelForAgent.mockReset();
    resolveDefaultModel.mockReset();
    createModelSelectionState.mockReset();
    resolveCurrentDirectiveLevels.mockReset();

    buildStatusReply.mockImplementation(async (params: unknown) => params);
    loadSessionEntry.mockReturnValue({
      cfg: {
        agents: {
          defaults: {
            reasoningDefault: "off",
          },
        },
      },
      canonicalKey: "main",
      entry: {
        sessionId: "sess-main",
      },
      store: {},
      storePath: "/tmp/sessions.json",
    });
    resolveSessionAgentId.mockReturnValue("main");
    listAgentEntries.mockReturnValue([]);
    resolveDefaultModelForAgent.mockReturnValue({ provider: "openai", model: "gpt-5.4" });
    resolveDefaultModel.mockReturnValue({ defaultProvider: "openai", defaultModel: "gpt-5.4" });
    createModelSelectionState.mockResolvedValue({
      resolveThinkingCatalog: vi.fn(async () => []),
      resolveDefaultThinkingLevel: vi.fn(async () => "off"),
      resolveDefaultReasoningLevel: vi.fn(async () => "on"),
    });
    resolveCurrentDirectiveLevels.mockResolvedValue({
      currentThinkLevel: "off",
      currentFastMode: false,
      currentVerboseLevel: "off",
      currentReasoningLevel: "off",
    });
  });

  it("treats agentCfg reasoningDefault as explicit for direct /status", async () => {
    const result = await resolveDirectStatusReplyForSessionCore({
      cfg: {},
      sessionKey: "main",
      channel: "cli",
      senderIsOwner: true,
      isAuthorizedSender: true,
      isGroup: false,
      defaultGroupActivation: () => "always",
    });

    expect(buildStatusReply).toHaveBeenCalledOnce();
    expectResolvedReasoningLevel(requireBuildStatusReplyParams(), "off");
    expectResolvedReasoningLevel(result, "off");
  });

  it("allows configured reasoning defaults for authorized direct /status senders", async () => {
    loadSessionEntry.mockReturnValue({
      cfg: {
        agents: {
          defaults: {
            reasoningDefault: "stream",
          },
        },
      },
      canonicalKey: "main",
      entry: {
        sessionId: "sess-main",
      },
      store: {},
      storePath: "/tmp/sessions.json",
    });
    resolveCurrentDirectiveLevels.mockResolvedValueOnce({
      currentThinkLevel: "off",
      currentFastMode: false,
      currentVerboseLevel: "off",
      currentReasoningLevel: "stream",
    });

    const result = await resolveDirectStatusReplyForSessionCore({
      cfg: {},
      sessionKey: "main",
      channel: "cli",
      senderIsOwner: false,
      isAuthorizedSender: true,
      isGroup: false,
      defaultGroupActivation: () => "always",
    });

    expectResolvedReasoningLevel(result, "stream");
  });

  it("hides configured reasoning defaults from unauthorized direct /status senders", async () => {
    loadSessionEntry.mockReturnValue({
      cfg: {
        agents: {
          defaults: {
            reasoningDefault: "stream",
          },
        },
      },
      canonicalKey: "main",
      entry: {
        sessionId: "sess-main",
      },
      store: {},
      storePath: "/tmp/sessions.json",
    });
    resolveCurrentDirectiveLevels.mockResolvedValueOnce({
      currentThinkLevel: "off",
      currentFastMode: false,
      currentVerboseLevel: "off",
      currentReasoningLevel: "stream",
    });

    const result = await resolveDirectStatusReplyForSessionCore({
      cfg: {},
      sessionKey: "main",
      channel: "cli",
      senderIsOwner: false,
      isAuthorizedSender: false,
      isGroup: false,
      defaultGroupActivation: () => "always",
    });

    expectResolvedReasoningLevel(result, "off");
  });

  it("hides session reasoning state from unauthorized direct /status senders", async () => {
    loadSessionEntry.mockReturnValue({
      cfg: {},
      canonicalKey: "main",
      entry: {
        sessionId: "sess-main",
        reasoningLevel: "stream",
      },
      store: {},
      storePath: "/tmp/sessions.json",
    });
    resolveCurrentDirectiveLevels.mockResolvedValueOnce({
      currentThinkLevel: "off",
      currentFastMode: false,
      currentVerboseLevel: "off",
      currentReasoningLevel: "stream",
    });

    const result = await resolveDirectStatusReplyForSessionCore({
      cfg: {},
      sessionKey: "main",
      channel: "cli",
      senderIsOwner: false,
      isAuthorizedSender: false,
      isGroup: false,
      defaultGroupActivation: () => "always",
    });

    expectResolvedReasoningLevel(result, "off");
  });

  it("allows session reasoning state for authorized direct /status senders", async () => {
    loadSessionEntry.mockReturnValue({
      cfg: {},
      canonicalKey: "main",
      entry: {
        sessionId: "sess-main",
        reasoningLevel: "stream",
      },
      store: {},
      storePath: "/tmp/sessions.json",
    });
    resolveCurrentDirectiveLevels.mockResolvedValueOnce({
      currentThinkLevel: "off",
      currentFastMode: false,
      currentVerboseLevel: "off",
      currentReasoningLevel: "stream",
    });

    const result = await resolveDirectStatusReplyForSessionCore({
      cfg: {},
      sessionKey: "main",
      channel: "cli",
      senderIsOwner: false,
      isAuthorizedSender: true,
      isGroup: false,
      defaultGroupActivation: () => "always",
    });

    expectResolvedReasoningLevel(result, "stream");
  });

  it("uses the sender-aware effective elevated level", async () => {
    loadSessionEntry.mockReturnValue({
      cfg: { tools: { elevated: { allowFrom: { discord: ["owner"] } } } },
      canonicalKey: "main",
      entry: { sessionId: "sess-main" },
      store: {},
      storePath: "/tmp/sessions.sqlite",
    });

    const result = await resolveDirectStatusReplyForSessionCore({
      cfg: {},
      sessionKey: "main",
      channel: "discord",
      accountId: "primary",
      senderId: "owner",
      senderIsOwner: true,
      isAuthorizedSender: true,
      isGroup: false,
      defaultGroupActivation: () => "always",
    });

    expect(result).toMatchObject({ resolvedElevatedLevel: "on" });
  });

  it("uses the peer policy key when a direct main-session peer requires sandboxing", async () => {
    const { replaceSessionEntry } = await import("../config/sessions/session-accessor.js");
    const storePath = path.join(tempDirs.make("openclaw-direct-status-policy-"), "sessions.sqlite");
    const cfg = {
      session: { store: storePath },
      tools: { elevated: { allowFrom: { discord: ["owner"] } } },
    };
    await replaceSessionEntry(
      {
        agentId: "main",
        sessionKey: "agent:main:discord:primary:direct:owner",
        storePath,
      },
      { sessionId: "peer-policy", sandbox: "required", updatedAt: Date.now() },
    );
    loadSessionEntry.mockReturnValue({
      cfg,
      canonicalKey: "main",
      entry: { sessionId: "sess-main" },
      store: {},
      storePath,
    });

    const result = await resolveDirectStatusReplyForSessionCore({
      cfg,
      sessionKey: "main",
      channel: "discord",
      accountId: "primary",
      senderId: "owner",
      senderIsOwner: true,
      isAuthorizedSender: true,
      isGroup: false,
      defaultGroupActivation: () => "always",
    });

    expect(result).toMatchObject({ resolvedElevatedLevel: "off" });
  });
});
