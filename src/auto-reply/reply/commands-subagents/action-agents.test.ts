import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const THREAD_CHANNEL = "thread-chat";
const ROOM_CHANNEL = "room-chat";
const MAIN_SESSION_KEY = "agent:main:main";

const { listBySessionMock, getChannelPluginMock, normalizeChannelIdMock } = vi.hoisted(() => ({
  listBySessionMock: vi.fn(),
  getChannelPluginMock: vi.fn((channel: string) =>
    channel === "thread-chat" || channel === "room-chat"
      ? {
          config: {
            hasPersistedAuthState: () => false,
          },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
          },
        }
      : null,
  ),
  normalizeChannelIdMock: vi.fn((channel: string) => channel),
}));

vi.mock("../../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    listBySession: listBySessionMock,
  }),
}));

vi.mock("../../../channels/plugins/index.js", () => ({
  getChannelPlugin: getChannelPluginMock,
  normalizeChannelId: normalizeChannelIdMock,
}));

let handleSubagentsAgentsAction: typeof import("./action-agents.js").handleSubagentsAgentsAction;

function activeBinding(params: {
  bindingId: string;
  channel: string;
  conversationId: string;
  targetSessionKey: string;
}) {
  return {
    bindingId: params.bindingId,
    targetSessionKey: params.targetSessionKey,
    targetKind: "subagent",
    conversation: {
      channel: params.channel,
      accountId: "default",
      conversationId: params.conversationId,
    },
    status: "active",
    boundAt: Date.now() - 20_000,
  };
}

function subagentRun(params: {
  childSessionKey: string;
  endedAgoMs?: number;
  runId: string;
  startedAgoMs?: number;
  task: string;
}) {
  const startedAgoMs = params.startedAgoMs ?? 20_000;
  return {
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: MAIN_SESSION_KEY,
    requesterDisplayKey: "main",
    task: params.task,
    cleanup: "keep",
    createdAt: Date.now() - startedAgoMs,
    startedAt: Date.now() - startedAgoMs,
    ...(params.endedAgoMs === undefined
      ? {}
      : { endedAt: Date.now() - params.endedAgoMs, outcome: { status: "ok" } }),
  };
}

function agentsActionInput(channel: string, runs: ReturnType<typeof subagentRun>[]) {
  return {
    params: {
      ctx: {
        Provider: channel,
        Surface: channel,
      },
      command: {
        channel,
      },
    },
    requesterKey: MAIN_SESSION_KEY,
    runs,
    restTokens: [],
  } as never;
}

describe("handleSubagentsAgentsAction", () => {
  beforeAll(async () => {
    ({ handleSubagentsAgentsAction } = await import("./action-agents.js"));
  });

  beforeEach(() => {
    listBySessionMock.mockReset();
    getChannelPluginMock.mockClear();
    normalizeChannelIdMock.mockClear();
  });

  it("dedupes stale bound rows for the same child session", () => {
    const childSessionKey = "agent:main:subagent:worker";
    listBySessionMock.mockImplementation((sessionKey: string) =>
      sessionKey === childSessionKey
        ? [
            activeBinding({
              bindingId: "binding-1",
              channel: THREAD_CHANNEL,
              conversationId: "thread-1",
              targetSessionKey: childSessionKey,
            }),
          ]
        : [],
    );

    const result = handleSubagentsAgentsAction(
      agentsActionInput(THREAD_CHANNEL, [
        subagentRun({
          runId: "run-current",
          childSessionKey,
          task: "current worker label",
          startedAgoMs: 10_000,
        }),
        subagentRun({
          runId: "run-stale",
          childSessionKey,
          task: "stale worker label",
          endedAgoMs: 15_000,
        }),
      ]),
    );

    expect(result.reply?.text).toContain("current worker label");
    expect(result.reply?.text).not.toContain("stale worker label");
  });

  it("keeps /agents numbering aligned with target resolution when hidden recent rows exist", () => {
    const hiddenSessionKey = "agent:main:subagent:hidden-recent";
    const visibleSessionKey = "agent:main:subagent:visible-bound";
    listBySessionMock.mockImplementation((sessionKey: string) =>
      sessionKey === visibleSessionKey
        ? [
            activeBinding({
              bindingId: "binding-visible",
              channel: THREAD_CHANNEL,
              conversationId: "thread-visible",
              targetSessionKey: visibleSessionKey,
            }),
          ]
        : [],
    );

    const result = handleSubagentsAgentsAction(
      agentsActionInput(THREAD_CHANNEL, [
        subagentRun({
          runId: "run-hidden-recent",
          childSessionKey: hiddenSessionKey,
          task: "hidden recent worker",
          startedAgoMs: 10_000,
          endedAgoMs: 5_000,
        }),
        subagentRun({
          runId: "run-visible-bound",
          childSessionKey: visibleSessionKey,
          task: "visible bound worker",
          endedAgoMs: 15_000,
        }),
      ]),
    );

    expect(result.reply?.text).toContain("2. visible bound worker");
    expect(result.reply?.text).not.toContain("1. visible bound worker");
    expect(result.reply?.text).not.toContain("hidden recent worker");
  });

  it("shows room-channel runs as unbound when the plugin supports conversation bindings", () => {
    listBySessionMock.mockReturnValue([]);

    const result = handleSubagentsAgentsAction(
      agentsActionInput(ROOM_CHANNEL, [
        subagentRun({
          runId: "run-room-worker",
          childSessionKey: "agent:main:subagent:room-worker",
          task: "room worker",
        }),
      ]),
    );

    expect(result.reply?.text).toContain("room worker (unbound)");
    expect(result.reply?.text).not.toContain("bindings unavailable");
  });

  it("formats bindings generically", () => {
    const childSessionKey = "agent:main:subagent:room-bound";
    listBySessionMock.mockImplementation((sessionKey: string) =>
      sessionKey === childSessionKey
        ? [
            activeBinding({
              bindingId: "binding-room",
              channel: ROOM_CHANNEL,
              conversationId: "room-thread-1",
              targetSessionKey: childSessionKey,
            }),
          ]
        : [],
    );

    const result = handleSubagentsAgentsAction(
      agentsActionInput(ROOM_CHANNEL, [
        subagentRun({
          runId: "run-room-bound",
          childSessionKey,
          task: "room bound worker",
        }),
      ]),
    );

    expect(result.reply?.text).toContain("room bound worker (binding:room-thread-1)");
  });

  it("shows bindings unavailable for channels without conversation binding support", () => {
    getChannelPluginMock.mockReturnValueOnce(null);
    listBySessionMock.mockReturnValue([]);

    const result = handleSubagentsAgentsAction(
      agentsActionInput("irc", [
        subagentRun({
          runId: "run-irc-worker",
          childSessionKey: "agent:main:subagent:irc-worker",
          task: "irc worker",
        }),
      ]),
    );

    expect(result.reply?.text).toContain("irc worker (bindings unavailable)");
  });
});
