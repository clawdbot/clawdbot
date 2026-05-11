import { beforeEach, describe, expect, it, vi } from "vitest";

const messageCommandMock = vi.fn(async () => {});
vi.mock("../../../commands/message.js", () => ({
  messageCommand: messageCommandMock,
}));

const getChannelPluginMock = vi.fn();
vi.mock("../../../channels/plugins/index.js", () => ({
  getChannelPlugin: getChannelPluginMock,
}));

vi.mock("../../../globals.js", () => ({
  danger: (s: string) => s,
  setVerbose: vi.fn(),
}));

vi.mock("../../plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: vi.fn(),
}));
const { ensurePluginRegistryLoaded } = await import("../../plugin-registry.js");

const hasHooksMock = vi.fn((_hookName: string) => false);
const runGatewayStopMock = vi.fn(
  async (_event: { reason?: string }, _ctx: Record<string, unknown>) => {},
);
const runGlobalGatewayStopSafelyMock = vi.fn(
  async (params: {
    event: { reason?: string };
    ctx: Record<string, unknown>;
    onError?: (err: unknown) => void;
  }) => {
    if (!hasHooksMock("gateway_stop")) {
      return;
    }
    try {
      await runGatewayStopMock(params.event, params.ctx);
    } catch (err) {
      params.onError?.(err);
    }
  },
);
vi.mock("../../../plugins/hook-runner-global.js", () => ({
  runGlobalGatewayStopSafely: runGlobalGatewayStopSafelyMock,
}));

const exitMock = vi.fn((): never => {
  throw new Error("exit");
});
const errorMock = vi.fn();
const runtimeMock = { log: vi.fn(), error: errorMock, exit: exitMock };
vi.mock("../../../runtime.js", () => ({
  defaultRuntime: runtimeMock,
}));

vi.mock("../../deps.js", () => ({
  createDefaultDeps: () => ({}),
}));

const { createMessageCliHelpers } = await import("./helpers.js");

const baseSendOptions = {
  channel: "discord",
  target: "123",
  message: "hi",
};

function createRunMessageAction() {
  const fakeCommand = { help: vi.fn() } as never;
  return createMessageCliHelpers(fakeCommand, "discord").runMessageAction;
}

async function runSendAction(opts: Record<string, unknown> = {}) {
  const runMessageAction = createRunMessageAction();
  await expect(runMessageAction("send", { ...baseSendOptions, ...opts })).rejects.toThrow("exit");
}

function mockChannelExecutionModes(modes: Record<string, "gateway" | "local"> = {}) {
  getChannelPluginMock.mockImplementation((id: string) => ({
    actions: {
      resolveExecutionMode: () => modes[id] ?? "local",
    },
  }));
}

function expectNoAccountFieldInPassedOptions() {
  const passedOpts = (
    messageCommandMock.mock.calls as unknown as Array<[Record<string, unknown>]>
  )?.[0]?.[0];
  if (passedOpts === undefined) {
    throw new Error("expected message command call");
  }
  expect(passedOpts).not.toHaveProperty("account");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectMessageCommandOptions(expected: Record<string, unknown>, callIndex = 0): void {
  const call = (messageCommandMock.mock.calls as unknown[][])[callIndex];
  if (!call) {
    throw new Error(`expected messageCommand call ${callIndex}`);
  }
  const options = requireRecord(call[0], `messageCommand options ${callIndex}`);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(options[key], `messageCommand options.${key}`).toEqual(expectedValue);
  }
  expect(call[1], "messageCommand runtime").not.toBeNull();
  expect(call[1], "messageCommand runtime").not.toBeUndefined();
  expect(call[2], "messageCommand deps").not.toBeNull();
  expect(call[2], "messageCommand deps").not.toBeUndefined();
}

describe("runMessageAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getChannelPluginMock.mockReset();
    mockChannelExecutionModes({ telegram: "gateway" });
    messageCommandMock.mockClear().mockResolvedValue(undefined);
    hasHooksMock.mockClear().mockReturnValue(false);
    runGatewayStopMock.mockClear().mockResolvedValue(undefined);
    runGlobalGatewayStopSafelyMock.mockClear();
    exitMock.mockClear().mockImplementation((): never => {
      throw new Error("exit");
    });
  });

  it("calls exit(0) after successful message delivery", async () => {
    await runSendAction();

    expect(ensurePluginRegistryLoaded).toHaveBeenCalledWith({
      scope: "configured-channels",
      onlyChannelIds: ["discord"],
    });
    expect(exitMock).toHaveBeenCalledOnce();
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("loads configured channel plugins when no target channel is known yet", async () => {
    await runSendAction({ channel: undefined });

    expect(ensurePluginRegistryLoaded).toHaveBeenCalledWith({
      scope: "configured-channels",
    });
  });

  it("narrows plugin loading from a channel-prefixed target", async () => {
    await runSendAction({ channel: undefined, target: "discord:channel:12345" });

    expect(ensurePluginRegistryLoaded).toHaveBeenCalledWith({
      scope: "configured-channels",
      onlyChannelIds: ["discord"],
    });
  });

  it("skips local plugin preload for any gateway-owned scoped channel action", async () => {
    mockChannelExecutionModes({ discord: "gateway" });

    await runSendAction({ target: "channel:12345" });

    expect(ensurePluginRegistryLoaded).not.toHaveBeenCalled();
    expectMessageCommandOptions({
      action: "send",
      channel: "discord",
      target: "channel:12345",
      message: "hi",
    });
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("keeps broadcast on the local preload path for same-channel prefixed targets", async () => {
    const runMessageAction = createRunMessageAction();

    await expect(
      runMessageAction("broadcast", {
        targets: ["telegram:1", "telegram:2"],
        message: "hi",
      }),
    ).rejects.toThrow("exit");

    expect(ensurePluginRegistryLoaded).toHaveBeenCalledWith({
      scope: "configured-channels",
      onlyChannelIds: ["telegram"],
    });
    expectMessageCommandOptions({
      action: "broadcast",
      targets: ["telegram:1", "telegram:2"],
      message: "hi",
    });
  });

  it("keeps unknown actions on the local preload path", async () => {
    mockChannelExecutionModes({ discord: "gateway" });
    const runMessageAction = createRunMessageAction();

    await expect(
      runMessageAction("custom-action", {
        ...baseSendOptions,
        target: "channel:12345",
      }),
    ).rejects.toThrow("exit");

    expect(ensurePluginRegistryLoaded).toHaveBeenCalledWith({
      scope: "configured-channels",
      onlyChannelIds: ["discord"],
    });
    expectMessageCommandOptions({ action: "custom-action" });
  });

  it("preloads when the scoped channel plugin is not cheaply available", async () => {
    getChannelPluginMock.mockReturnValue(undefined);

    await runSendAction({ target: "channel:12345" });

    expect(ensurePluginRegistryLoaded).toHaveBeenCalledWith({
      scope: "configured-channels",
      onlyChannelIds: ["discord"],
    });
  });

  it("keeps target-prefixed Telegram sends from local plugin preload", async () => {
    await runSendAction({ channel: undefined, target: "telegram:12345" });

    expect(ensurePluginRegistryLoaded).not.toHaveBeenCalled();
    expectMessageCommandOptions({
      action: "send",
      target: "telegram:12345",
      message: "hi",
    });
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("keeps explicit Telegram sends on the normal command path without local plugin preload", async () => {
    await runSendAction({
      channel: "telegram",
      account: "default",
      target: "@ops",
      media: "./diagram.png",
      presentation: '{"blocks":[{"type":"buttons","buttons":[{"label":"OK","value":"ok"}]}]}',
      delivery: '{"pin":true}',
      forceDocument: true,
    });

    expect(ensurePluginRegistryLoaded).not.toHaveBeenCalled();
    expectMessageCommandOptions({
      action: "send",
      channel: "telegram",
      accountId: "default",
      target: "@ops",
      message: "hi",
      media: "./diagram.png",
      presentation: '{"blocks":[{"type":"buttons","buttons":[{"label":"OK","value":"ok"}]}]}',
      delivery: '{"pin":true}',
      forceDocument: true,
    });
    expectNoAccountFieldInPassedOptions();
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("keeps Telegram dry-runs on the local preload path for local validation", async () => {
    await runSendAction({
      channel: "telegram",
      target: "@ops",
      dryRun: true,
    });

    expect(ensurePluginRegistryLoaded).toHaveBeenCalledWith({
      scope: "configured-channels",
      onlyChannelIds: ["telegram"],
    });
    expect(messageCommandMock).toHaveBeenCalled();
  });

  it("loads configured channel plugins for mixed broadcast target prefixes", async () => {
    const runMessageAction = createRunMessageAction();

    await expect(
      runMessageAction("broadcast", {
        targets: ["discord:channel:1", "telegram:123"],
        message: "hi",
      }),
    ).rejects.toThrow("exit");

    expect(ensurePluginRegistryLoaded).toHaveBeenCalledWith({
      scope: "configured-channels",
    });
  });

  it("exits with failure when plugin registry loading fails before dispatch", async () => {
    vi.mocked(ensurePluginRegistryLoaded).mockImplementationOnce(() => {
      throw new Error("plugin load failed");
    });

    await runSendAction();

    expect(messageCommandMock).not.toHaveBeenCalled();
    expect(errorMock).toHaveBeenCalledWith("Error: plugin load failed");
    expect(exitMock).toHaveBeenCalledOnce();
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(exitMock).not.toHaveBeenCalledWith(0);
  });

  it("runs gateway_stop hooks before exit when registered", async () => {
    hasHooksMock.mockReturnValueOnce(true);
    await runSendAction();

    expect(runGatewayStopMock).toHaveBeenCalledWith({ reason: "cli message action complete" }, {});
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("skips gateway_stop hooks for read-only message reads", async () => {
    hasHooksMock.mockReturnValueOnce(true);
    const runMessageAction = createRunMessageAction();

    await expect(
      runMessageAction("read", {
        channel: "discord",
        target: "channel:123",
        limit: 1,
      }),
    ).rejects.toThrow("exit");

    expect(runGlobalGatewayStopSafelyMock).not.toHaveBeenCalled();
    expect(runGatewayStopMock).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("bounds gateway_stop hooks so message actions still exit", async () => {
    vi.useFakeTimers();
    try {
      hasHooksMock.mockReturnValueOnce(true);
      runGatewayStopMock.mockImplementationOnce(() => new Promise(() => undefined));
      const runMessageAction = createRunMessageAction();

      const pending = expect(runMessageAction("send", baseSendOptions)).rejects.toThrow("exit");
      await vi.advanceTimersByTimeAsync(2500);
      await pending;

      expect(errorMock).toHaveBeenCalledWith("gateway_stop hook exceeded 2500ms; continuing");
      expect(exitMock).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls exit(1) when message delivery fails", async () => {
    messageCommandMock.mockRejectedValueOnce(new Error("send failed"));
    await runSendAction();

    expect(errorMock).toHaveBeenCalledWith("Error: send failed");
    expect(exitMock).toHaveBeenCalledOnce();
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("runs gateway_stop hooks on failure before exit(1)", async () => {
    hasHooksMock.mockReturnValueOnce(true);
    messageCommandMock.mockRejectedValueOnce(new Error("send failed"));
    await runSendAction();

    expect(runGatewayStopMock).toHaveBeenCalledWith({ reason: "cli message action complete" }, {});
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("logs gateway_stop failure and still exits with success code", async () => {
    hasHooksMock.mockReturnValueOnce(true);
    runGatewayStopMock.mockRejectedValueOnce(new Error("hook failed"));
    await runSendAction();

    expect(errorMock).toHaveBeenCalledWith("gateway_stop hook failed: Error: hook failed");
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("logs gateway_stop failure and preserves failure exit code when send fails", async () => {
    hasHooksMock.mockReturnValueOnce(true);
    messageCommandMock.mockRejectedValueOnce(new Error("send failed"));
    runGatewayStopMock.mockRejectedValueOnce(new Error("hook failed"));
    await runSendAction();

    expect(errorMock).toHaveBeenNthCalledWith(1, "Error: send failed");
    expect(errorMock).toHaveBeenNthCalledWith(2, "gateway_stop hook failed: Error: hook failed");
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("does not call exit(0) when the action throws", async () => {
    messageCommandMock.mockRejectedValueOnce(new Error("boom"));
    await runSendAction();

    // exit should only be called once with code 1, never with 0
    expect(exitMock).toHaveBeenCalledOnce();
    expect(exitMock).not.toHaveBeenCalledWith(0);
  });

  it("does not call exit(0) if the error path returns", async () => {
    messageCommandMock.mockRejectedValueOnce(new Error("boom"));
    exitMock.mockClear().mockImplementation(() => undefined as never);
    const runMessageAction = createRunMessageAction();
    await expect(runMessageAction("send", baseSendOptions)).resolves.toBeUndefined();

    expect(errorMock).toHaveBeenCalledWith("Error: boom");
    expect(exitMock).toHaveBeenCalledOnce();
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(exitMock).not.toHaveBeenCalledWith(0);
  });

  it("passes action and maps account to accountId", async () => {
    const fakeCommand = { help: vi.fn() } as never;
    const { runMessageAction } = createMessageCliHelpers(fakeCommand, "discord");

    await expect(
      runMessageAction("poll", {
        channel: "discord",
        target: "456",
        account: "acct-1",
        message: "hi",
      }),
    ).rejects.toThrow("exit");

    expectMessageCommandOptions({
      action: "poll",
      channel: "discord",
      target: "456",
      accountId: "acct-1",
      message: "hi",
    });
    // account key should be stripped in favor of accountId
    expectNoAccountFieldInPassedOptions();
  });

  it("strips non-string account values instead of passing accountId", async () => {
    const runMessageAction = createRunMessageAction();

    await expect(
      runMessageAction("send", {
        channel: "discord",
        target: "789",
        account: 42,
        message: "hi",
      }),
    ).rejects.toThrow("exit");

    expectMessageCommandOptions({
      action: "send",
      channel: "discord",
      target: "789",
      accountId: undefined,
    });
    expectNoAccountFieldInPassedOptions();
  });
});
