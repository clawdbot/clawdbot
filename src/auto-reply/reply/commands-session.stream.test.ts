// Tests selection, status, and persistence for the per-session preview streaming command.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/index.js";
import type { OpenClawConfig } from "../../config/config.js";
import { handleStreamCommand } from "./commands-session-stream.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const persistCommandSessionMock = vi.hoisted(() => vi.fn(async () => true));
const resolvedAccount = { accountId: "opaque-account" };
type ResolveSessionMode = NonNullable<
  NonNullable<ChannelPlugin<typeof resolvedAccount>["streaming"]>["resolveSessionMode"]
>;
const resolveSessionModeMock = vi.hoisted(() =>
  vi.fn<ResolveSessionMode>((params) => {
    const sessionMode = params.sessionMode;
    if (
      sessionMode === "off" ||
      sessionMode === "partial" ||
      sessionMode === "block" ||
      sessionMode === "progress"
    ) {
      return { mode: sessionMode, source: "session" as const };
    }
    return { mode: "progress" as const, source: "channel default" as const };
  }),
);
const getChannelPluginMock = vi.hoisted(() =>
  vi.fn<
    () => {
      streaming: {
        sessionModeDefault?: "off" | "partial" | "block" | "progress";
        resolveSessionMode?: typeof resolveSessionModeMock;
      };
      config: { resolveAccount: () => typeof resolvedAccount };
    }
  >(() => ({
    streaming: { sessionModeDefault: "progress", resolveSessionMode: resolveSessionModeMock },
    config: { resolveAccount: () => resolvedAccount },
  })),
);
const persistenceConflictReply = vi.hoisted(() => ({
  shouldContinue: false,
  reply: { text: "retry stream command" },
}));

vi.mock("./commands-session-store.js", () => ({
  persistCommandSession: persistCommandSessionMock,
  sessionEntryPersistenceConflictReply: () => persistenceConflictReply,
}));

vi.mock("../../channels/plugins/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/plugins/index.js")>(
    "../../channels/plugins/index.js",
  );
  return { ...actual, getChannelPlugin: getChannelPluginMock };
});

function buildStreamParams(commandBodyNormalized: string): HandleCommandsParams {
  const sessionEntry = { sessionId: "session-1", updatedAt: 1, streamingMode: "block" as const };
  const params = buildCommandTestParams(
    commandBodyNormalized,
    { commands: { text: true } } as OpenClawConfig,
    { Provider: "telegram", Surface: "telegram" },
  );
  return {
    ...params,
    sessionKey: "telegram:dm:owner",
    sessionEntry,
    sessionStore: { "telegram:dm:owner": sessionEntry },
  };
}

describe("handleStreamCommand", () => {
  beforeEach(() => {
    persistCommandSessionMock.mockReset().mockResolvedValue(true);
    resolveSessionModeMock.mockClear();
    getChannelPluginMock.mockReset().mockReturnValue({
      streaming: { sessionModeDefault: "progress", resolveSessionMode: resolveSessionModeMock },
      config: { resolveAccount: () => resolvedAccount },
    });
  });

  it("persists only the target session store entry's streaming mode field", async () => {
    const params = buildStreamParams("/stream progress");
    const wrapperEntry = params.sessionEntry;
    const targetEntry = { sessionId: "session-target", updatedAt: 2 };
    params.sessionStore = { [params.sessionKey]: targetEntry };

    await expect(handleStreamCommand(params, true)).resolves.toMatchObject({
      reply: { text: "⚙️ Stream mode set to progress." },
    });
    expect(wrapperEntry?.streamingMode).toBe("block");
    expect(targetEntry).toMatchObject({ streamingMode: "progress" });
    expect(persistCommandSessionMock).toHaveBeenCalledWith({
      ...params,
      sessionEntry: targetEntry,
      touchedFields: ["streamingMode"],
    });
  });

  it("reports a concurrent session change instead of acknowledging a reset", async () => {
    const params = buildStreamParams("/stream default");
    persistCommandSessionMock.mockResolvedValueOnce(false);

    await expect(handleStreamCommand(params, true)).resolves.toEqual(persistenceConflictReply);
    expect(persistCommandSessionMock).toHaveBeenCalledWith({
      ...params,
      sessionEntry: params.sessionEntry,
      touchedFields: ["streamingMode"],
    });
  });

  it.each([
    ["/streaming block", "block", "⚙️ Stream mode set to block."],
    ["/stream final", "off", "⚙️ Stream mode set to off (preview disabled)."],
  ] as const)("accepts %s", async (command, expectedMode, expectedText) => {
    const params = buildStreamParams(command);

    const result = await handleStreamCommand(params, true);

    expect(params.sessionEntry?.streamingMode).toBe(expectedMode);
    expect(result?.reply?.text).toBe(expectedText);
  });

  it("reports the persisted session override", async () => {
    const params = buildStreamParams("/stream status");

    const result = await handleStreamCommand(params, true);

    expect(result?.reply?.text).toBe("⚙️ Current stream mode: block (session).");
    expect(resolveSessionModeMock).toHaveBeenCalledWith({
      account: resolvedAccount,
      sessionMode: "block",
    });
    expect(persistCommandSessionMock).not.toHaveBeenCalled();
  });

  it("reports a configured preview mode when the session has no override", async () => {
    const params = buildStreamParams("/stream status");
    delete params.sessionEntry?.streamingMode;
    resolveSessionModeMock.mockReturnValueOnce({ mode: "partial", source: "channel config" });

    const result = await handleStreamCommand(params, true);

    expect(result?.reply?.text).toBe("⚙️ Current stream mode: partial (channel config).");
    expect(resolveSessionModeMock).toHaveBeenCalledWith({
      account: resolvedAccount,
      sessionMode: undefined,
    });
  });

  it("reports the channel default when only unrelated streaming config exists", async () => {
    const params = buildStreamParams("/stream status");
    delete params.sessionEntry?.streamingMode;

    const result = await handleStreamCommand(params, true);

    expect(result?.reply?.text).toBe("⚙️ Current stream mode: progress (channel default).");
  });

  it("clears the override and reports the newly inherited mode", async () => {
    const params = buildStreamParams("/stream default");
    resolveSessionModeMock.mockReturnValueOnce({ mode: "partial", source: "channel config" });

    const result = await handleStreamCommand(params, true);

    expect(params.sessionEntry?.streamingMode).toBeUndefined();
    expect(result?.reply?.text).toBe("⚙️ Stream mode reset to partial (channel config).");
    expect(resolveSessionModeMock).toHaveBeenCalledWith({
      account: resolvedAccount,
      sessionMode: undefined,
    });
  });

  it("rejects invalid selections without changing the session", async () => {
    const params = buildStreamParams("/stream sometimes");

    const result = await handleStreamCommand(params, true);

    expect(params.sessionEntry?.streamingMode).toBe("block");
    expect(result?.reply?.text).toBe("⚙️ Usage: /stream status|off|partial|block|progress|default");
    expect(persistCommandSessionMock).not.toHaveBeenCalled();
  });

  it("does not save overrides for channels without the delivery capability", async () => {
    getChannelPluginMock.mockReturnValue({
      streaming: { sessionModeDefault: "progress" },
      config: { resolveAccount: () => resolvedAccount },
    });
    const params = buildStreamParams("/stream partial");

    const result = await handleStreamCommand(params, true);

    expect(params.sessionEntry?.streamingMode).toBe("block");
    expect(result?.reply?.text).toBe("⚙️ /stream isn't supported on this channel yet.");
    expect(persistCommandSessionMock).not.toHaveBeenCalled();
  });
});
