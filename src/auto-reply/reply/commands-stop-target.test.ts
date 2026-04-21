import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handleStopCommand } from "./commands-session-abort.js";
import "./commands-session-abort.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

const abortEmbeddedPiRunMock = vi.hoisted(() => vi.fn());
const createInternalHookEventMock = vi.hoisted(() => vi.fn(() => ({})));
const persistAbortTargetEntryMock = vi.hoisted(() => vi.fn(async () => true));
const replyRunAbortMock = vi.hoisted(() => vi.fn());
const resolveSessionIdMock = vi.hoisted(() => vi.fn(() => undefined));
const stopSubagentsForRequesterMock = vi.hoisted(() => vi.fn(() => ({ stopped: 0 })));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: abortEmbeddedPiRunMock,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: createInternalHookEventMock,
  triggerInternalHook: vi.fn(async () => undefined),
}));

vi.mock("./abort-cutoff.js", () => ({
  resolveAbortCutoffFromContext: vi.fn(() => undefined),
  shouldPersistAbortCutoff: vi.fn(() => false),
}));

vi.mock("./abort.js", () => ({
  formatAbortReplyText: vi.fn(() => "⚙️ Agent was aborted."),
  isAbortTrigger: vi.fn(() => false),
  resolveSessionEntryForKey: vi.fn(() => ({ entry: undefined, key: undefined })),
  setAbortMemory: vi.fn(),
  stopSubagentsForRequester: stopSubagentsForRequesterMock,
}));

vi.mock("./commands-session-store.js", () => ({
  persistAbortTargetEntry: persistAbortTargetEntryMock,
}));

vi.mock("./reply-run-registry.js", () => ({
  replyRunRegistry: {
    abort: replyRunAbortMock,
    resolveSessionId: resolveSessionIdMock,
  },
}));

function buildStopParams(): HandleCommandsParams {
  return {
    cfg: {
      commands: { text: true },
      channels: { telegram: { allowFrom: ["*"] } },
    } as OpenClawConfig,
    ctx: {
      Provider: "telegram",
      Surface: "telegram",
      CommandSource: "text",
      CommandTargetSessionKey: "agent:target:telegram:direct:123",
    },
    command: {
      commandBodyNormalized: "/stop",
      rawBodyNormalized: "/stop",
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "owner",
      channel: "telegram",
      channelId: "telegram",
      surface: "telegram",
      ownerList: [],
      from: "owner",
      to: "bot",
    },
    sessionKey: "agent:main:telegram:slash-session",
    sessionEntry: {
      sessionId: "wrapper-session-id",
      updatedAt: Date.now(),
    },
    sessionStore: {},
    storePath: "/tmp/sessions.json",
  } as unknown as HandleCommandsParams;
}

describe("handleStopCommand target fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistAbortTargetEntryMock.mockResolvedValue(true);
  });

  it("does not fall back to the wrapper session when a distinct target session is missing from store", async () => {
    const params = buildStopParams();

    const result = await handleStopCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚙️ Agent was aborted." },
    });
    expect(replyRunAbortMock).toHaveBeenCalledWith("agent:target:telegram:direct:123");
    expect(abortEmbeddedPiRunMock).not.toHaveBeenCalledWith("wrapper-session-id");
    expect(persistAbortTargetEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "agent:target:telegram:direct:123",
        entry: undefined,
      }),
    );
    expect(stopSubagentsForRequesterMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSessionKey: "agent:target:telegram:direct:123",
      }),
    );
    expect(createInternalHookEventMock).toHaveBeenCalledWith(
      "command",
      "stop",
      "agent:target:telegram:direct:123",
      expect.objectContaining({
        sessionEntry: undefined,
      }),
    );
  });
});
