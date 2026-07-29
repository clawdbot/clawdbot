// Tests abort trigger command parsing and cancellation requests.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handleAbortTrigger } from "./commands-session-abort.js";
import "./commands-session-abort.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

const abortEmbeddedAgentRunMock = vi.hoisted(() => vi.fn());
const persistAbortTargetEntryMock = vi.hoisted(() => vi.fn());
const resolveCommandSessionEntryForKeyMock = vi.hoisted(() =>
  vi.fn(() => ({ entry: undefined, key: "agent:main:main" })),
);
const setAbortMemoryMock = vi.hoisted(() => vi.fn());
const abortSessionRunTargetWithOutcomeMock = vi.hoisted(() =>
  vi.fn(() => ({ active: false, aborted: false })),
);
const formatAbortReplyTextMock = vi.hoisted(() => vi.fn(() => "⚙️ Agent was aborted."));

vi.mock("../../agents/embedded-agent.js", () => ({
  abortEmbeddedAgentRun: abortEmbeddedAgentRunMock,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(),
}));

vi.mock("./abort-cutoff.js", () => ({
  resolveAbortCutoffFromContext: vi.fn(() => undefined),
  shouldPersistAbortCutoff: vi.fn(() => false),
}));

vi.mock("./abort.js", () => ({
  abortSessionRunTargetWithOutcome: abortSessionRunTargetWithOutcomeMock,
  formatAbortReplyText: formatAbortReplyTextMock,
  isAbortTrigger: vi.fn((raw: string) => raw === "stop"),
  setAbortMemory: setAbortMemoryMock,
  stopSubagentsForRequester: vi.fn(() => ({ stopped: 0 })),
}));

vi.mock("./commands-session-store.js", () => ({
  persistAbortTargetEntry: persistAbortTargetEntryMock,
  resolveCommandSessionEntryForKey: resolveCommandSessionEntryForKeyMock,
}));

vi.mock("./reply-run-registry.js", () => ({
  replyRunRegistry: {
    abort: vi.fn(),
    resolveSessionId: vi.fn(() => undefined),
  },
}));

function buildAbortParams(): HandleCommandsParams {
  return {
    cfg: {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
    },
    command: {
      commandBodyNormalized: "stop",
      rawBodyNormalized: "stop",
      isAuthorizedSender: false,
      senderIsOwner: false,
      senderId: "unauthorized",
      channel: "whatsapp",
      channelId: "whatsapp",
      surface: "whatsapp",
      ownerList: [],
      from: "unauthorized",
      to: "bot",
    },
    sessionKey: "agent:main:main",
    sessionEntry: {
      sessionId: "session-1",
      updatedAt: Date.now(),
      abortedLastRun: false,
    },
    sessionStore: {
      "agent:main:main": {
        sessionId: "session-1",
        updatedAt: Date.now(),
        abortedLastRun: false,
      },
    },
  } as unknown as HandleCommandsParams;
}

describe("handleAbortTrigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    abortSessionRunTargetWithOutcomeMock.mockReturnValue({ active: false, aborted: false });
  });

  it("rejects unauthorized natural-language abort triggers", async () => {
    const result = await handleAbortTrigger(buildAbortParams(), true);
    expect(result).toEqual({ shouldContinue: false });
    expect(abortSessionRunTargetWithOutcomeMock).not.toHaveBeenCalled();
    expect(abortEmbeddedAgentRunMock).not.toHaveBeenCalled();
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
    expect(setAbortMemoryMock).not.toHaveBeenCalled();
  });

  it("reports a finalizing run without persisting abort state", async () => {
    const params = buildAbortParams();
    params.command.isAuthorizedSender = true;
    params.command.senderIsOwner = true;
    abortSessionRunTargetWithOutcomeMock.mockReturnValue({ active: true, aborted: false });
    formatAbortReplyTextMock.mockReturnValue(
      "Agent reply is already finalizing and can no longer be aborted.",
    );

    const result = await handleAbortTrigger(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Agent reply is already finalizing and can no longer be aborted." },
    });
    expect(formatAbortReplyTextMock).toHaveBeenCalledWith(undefined, "finalizing");
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
    expect(setAbortMemoryMock).not.toHaveBeenCalled();
  });
});
