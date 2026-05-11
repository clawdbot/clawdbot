import { beforeEach, describe, expect, it, vi } from "vitest";

const buildStatusReply = vi.fn(async (params: unknown) => params);
const loadSessionEntry = vi.fn();
const resolveSessionAgentId = vi.fn();
const listAgentEntries = vi.fn();
const resolveDefaultModelForAgent = vi.fn();
const resolveDefaultModel = vi.fn();
const createModelSelectionState = vi.fn();
const resolveCurrentDirectiveLevels = vi.fn();

vi.mock("../auto-reply/reply/commands-status.js", () => ({
  buildStatusReply,
}));

vi.mock("../gateway/session-utils.js", () => ({
  loadSessionEntry,
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentEntries,
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

const { resolveDirectStatusReplyForSession } = await import("./command-status.runtime.js");

function expectResolvedReasoningLevel(value: unknown, expected: string) {
  expect((value as { resolvedReasoningLevel?: unknown }).resolvedReasoningLevel).toBe(expected);
}

describe("resolveDirectStatusReplyForSession", () => {
  beforeEach(() => {
    buildStatusReply.mockReset();
    loadSessionEntry.mockReset();
    resolveSessionAgentId.mockReset();
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
      resolveDefaultThinkingLevel: vi.fn(async () => "off"),
      resolveDefaultReasoningLevel: vi.fn(async () => "on"),
    });
    resolveCurrentDirectiveLevels.mockResolvedValue({
      currentThinkLevel: "off",
      currentFastMode: false,
      currentVerboseLevel: "off",
      currentReasoningLevel: "off",
      currentElevatedLevel: "off",
    });
  });

  it("treats agentCfg reasoningDefault as explicit for direct /status", async () => {
    const result = await resolveDirectStatusReplyForSession({
      cfg: {},
      sessionKey: "main",
      channel: "cli",
      senderIsOwner: true,
      isAuthorizedSender: true,
      isGroup: false,
      defaultGroupActivation: () => "always",
    });

    expect(buildStatusReply).toHaveBeenCalledOnce();
    expectResolvedReasoningLevel(buildStatusReply.mock.calls[0]?.[0], "off");
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
      currentElevatedLevel: "off",
    });

    const result = await resolveDirectStatusReplyForSession({
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
      currentElevatedLevel: "off",
    });

    const result = await resolveDirectStatusReplyForSession({
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
      currentElevatedLevel: "off",
    });

    const result = await resolveDirectStatusReplyForSession({
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
      currentElevatedLevel: "off",
    });

    const result = await resolveDirectStatusReplyForSession({
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
});
