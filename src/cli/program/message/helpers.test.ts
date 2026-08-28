// Message program helper tests cover message command helper behavior and mocks.
import { Command } from "commander";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMessagePollCommand } from "./register.poll.js";
import { registerMessageReactionsCommands } from "./register.reactions.js";
import { registerMessageReadEditDeleteCommands } from "./register.read-edit-delete.js";
import { registerMessageSendCommand } from "./register.send.js";

const messageCommandMock = vi.fn(async (): Promise<unknown> => undefined);
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

const loadPluginRegistryHandleMock = vi.fn(() => ({ gatewayHandlers: {} }));
vi.mock("../../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../../plugins/channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPluginIds: () => ["configured-channel"],
  resolveDiscoverableScopedChannelPluginIds: (params: { channelIds: string[] }) =>
    params.channelIds,
}));
vi.mock("../../../plugins/loader.js", () => ({
  loadPluginRegistryHandle: loadPluginRegistryHandleMock,
}));

const hasHooksMock = vi.fn((_hookName: string) => false);
const runGatewayStopMock = vi.fn(
  async (_eventValue: { reason?: string }, _ctx: Record<string, unknown>) => {},
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

const exitMock = vi.fn((_code: number): never => {
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

const NON_NEGATIVE_INTEGER_FLAGS = new Set(["--delete-days", "--duration-min"]);

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

const requireRecord = createRequireRecord("record", "expected-label-object");

function expectMessageCommandOptions(expected: Record<string, unknown>, callIndex = 0): void {
  const call = (messageCommandMock.mock.calls as unknown[][])[callIndex];
  if (!call) {
    throw new Error(`expected messageCommand call ${callIndex}`);
  }
  const options = requireRecord(call[0], `messageCommand options ${callIndex}`);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(options[key], `messageCommand options.${key}`).toEqual(expectedValue);
  }
  if (call[1] == null) {
    throw new Error("expected messageCommand runtime");
  }
  if (call[2] == null) {
    throw new Error("expected messageCommand deps");
  }
}

function expectRegistryLoad(pluginIds: string[]): void {
  expect(loadPluginRegistryHandleMock).toHaveBeenCalledWith(
    expect.objectContaining({ onlyPluginIds: pluginIds, throwOnLoadError: true }),
  );
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
    exitMock.mockClear().mockImplementation((_code: number): never => {
      throw new Error("exit");
    });
  });

  it("calls exit(0) after successful message delivery", async () => {
    await runSendAction();

    expectRegistryLoad(["discord"]);
    expect(exitMock).toHaveBeenCalledOnce();
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it.each([
    { name: "sent", status: "sent" as const, exitCode: 0 },
    { name: "suppressed", status: "suppressed" as const, exitCode: 1 },
    { name: "failed", status: "failed" as const, exitCode: 1 },
    { name: "partial_failed", status: "partial_failed" as const, exitCode: 1 },
    { name: "dry-run", status: undefined, dryRun: true, exitCode: 0 },
  ])(
    "propagates $name send outcomes through the real CLI parser",
    async ({ status, dryRun, exitCode }) => {
      const sendResult = {
        channel: "discord",
        to: "channel:123",
        via: "direct" as const,
        mediaUrl: null,
        ...(status ? { deliveryStatus: status } : {}),
        ...(status === "suppressed"
          ? { suppressionReason: "cancelled_by_message_sending_hook" as const }
          : {}),
        ...(status === "failed" || status === "partial_failed"
          ? { error: "provider rejected the message" }
          : {}),
        ...(status === "partial_failed"
          ? { sentBeforeError: true as const, result: { channel: "discord", messageId: "part-1" } }
          : {}),
      };
      messageCommandMock.mockResolvedValueOnce({
        kind: "send",
        channel: "discord",
        action: "send",
        to: "channel:123",
        handledBy: "core",
        payload: sendResult,
        sendResult,
        dryRun: Boolean(dryRun),
      });
      const program = new Command();
      const message = program.command("message");
      registerMessageSendCommand(message, createMessageCliHelpers(message, "discord"));

      await expect(
        program.parseAsync(
          [
            "message",
            "send",
            "--channel",
            "discord",
            "--target",
            "channel:123",
            "--message",
            "hi",
            ...(dryRun ? ["--dry-run"] : []),
          ],
          { from: "user" },
        ),
      ).rejects.toThrow("exit");

      expect(exitMock).toHaveBeenCalledWith(exitCode);
    },
  );

  it.each([
    ["disabled reaction", "react", { ok: false, hint: "Reactions are disabled." }, 1],
    ["rejected added reaction", "react", { ok: false, warning: "Unavailable", added: "✅" }, 1],
    ["rejected delete", "delete", { ok: false, deleted: false, warning: "Not deleted" }, 1],
    ["rejected poll", "poll", { ok: false, error: "Poll rejected" }, 1],
    ["rejected send", "send", { ok: false, error: "Message rejected" }, 1],
    ["successful reaction", "react", { ok: true, added: "✅" }, 0],
    ["legacy reaction", "react", { added: "✅" }, 0],
    ["non-boolean outcome", "react", { ok: "false", added: "✅" }, 0],
    ["dry-run", "react", { ok: false, error: "Not executed" }, 0],
  ] as const)(
    "propagates %s through the real CLI parser",
    async (name, action, payload, exitCode) => {
      const dryRun = name === "dry-run";
      const kind = action === "send" || action === "poll" ? action : "action";
      messageCommandMock.mockResolvedValueOnce({
        kind,
        channel: "telegram",
        action,
        ...(kind === "action" ? {} : { to: "123" }),
        handledBy: "plugin",
        payload,
        dryRun,
      });
      const program = new Command();
      const message = program.command("message");
      const helpers = createMessageCliHelpers(message, "telegram");
      registerMessageSendCommand(message, helpers);
      registerMessagePollCommand(message, helpers);
      registerMessageReactionsCommands(message, helpers);
      registerMessageReadEditDeleteCommands(message, helpers);
      const args = {
        react: ["--message-id", "456", "--emoji", "✅"],
        delete: ["--message-id", "456"],
        poll: ["--poll-question", "Ready?", "--poll-option", "Yes", "--poll-option", "No"],
        send: ["--message", "hello"],
      }[action];

      await expect(
        program.parseAsync(
          [
            "message",
            action,
            "--channel",
            "telegram",
            "--target",
            "123",
            ...args,
            ...(dryRun ? ["--dry-run"] : []),
          ],
          { from: "user" },
        ),
      ).rejects.toThrow("exit");

      expect(exitMock).toHaveBeenCalledWith(exitCode);
    },
  );

  it("loads configured channel plugins when no target channel is known yet", async () => {
    await runSendAction({ channel: undefined });

    expectRegistryLoad(["configured-channel"]);
  });

  it("narrows plugin loading from a channel-prefixed target", async () => {
    await runSendAction({ channel: undefined, target: "discord:channel:12345" });

    expectRegistryLoad(["discord"]);
  });

  it("skips local plugin preload for any gateway-owned scoped channel action", async () => {
    mockChannelExecutionModes({ discord: "gateway" });

    await runSendAction({ target: "channel:12345" });

    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
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

    expectRegistryLoad(["telegram"]);
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

    expectRegistryLoad(["discord"]);
    expectMessageCommandOptions({ action: "custom-action" });
  });

  it("preloads when the scoped channel plugin is not cheaply available", async () => {
    getChannelPluginMock.mockReturnValue(undefined);

    await runSendAction({ target: "channel:12345" });

    expectRegistryLoad(["discord"]);
  });

  it("keeps target-prefixed Telegram sends from local plugin preload", async () => {
    await runSendAction({ channel: undefined, target: "telegram:12345" });

    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
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

    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
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

    expectRegistryLoad(["telegram"]);
    expect(messageCommandMock).toHaveBeenCalledTimes(1);
  });

  it("loads configured channel plugins for mixed broadcast target prefixes", async () => {
    const runMessageAction = createRunMessageAction();

    await expect(
      runMessageAction("broadcast", {
        targets: ["discord:channel:1", "telegram:123"],
        message: "hi",
      }),
    ).rejects.toThrow("exit");

    expectRegistryLoad(["configured-channel"]);
  });

  it("exits with failure when plugin registry loading fails before dispatch", async () => {
    loadPluginRegistryHandleMock.mockImplementationOnce(() => {
      throw new Error("plugin load failed");
    });

    await runSendAction();

    expect(messageCommandMock).not.toHaveBeenCalled();
    expect(errorMock).toHaveBeenCalledWith("plugin load failed");
    expect(exitMock).toHaveBeenCalledOnce();
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(exitMock).not.toHaveBeenCalledWith(0);
  });

  it("rejects conflicting poll visibility flags before loading channel plugins", async () => {
    const runMessageAction = createRunMessageAction();

    await expect(
      runMessageAction("poll", {
        channel: "telegram",
        target: "123",
        pollQuestion: "Ship it?",
        pollOption: ["Yes", "No"],
        pollAnonymous: true,
        pollPublic: true,
      }),
    ).rejects.toThrow("exit");

    expect(errorMock).toHaveBeenCalledWith(
      "--poll-anonymous and --poll-public are mutually exclusive.",
    );
    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
    expect(messageCommandMock).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(exitMock).not.toHaveBeenCalledWith(0);
  });

  it.each([
    [
      "poll duration hours",
      "poll",
      {
        channel: "discord",
        target: "123",
        pollQuestion: "ship?",
        pollOption: ["yes", "no"],
        pollDurationHours: "1.5",
      },
      "--poll-duration-hours",
    ],
    [
      "poll duration seconds",
      "poll",
      {
        channel: "telegram",
        target: "123",
        pollQuestion: "ship?",
        pollOption: ["yes", "no"],
        pollDurationSeconds: "60s",
      },
      "--poll-duration-seconds",
    ],
    [
      "timeout duration",
      "timeout",
      { guildId: "g", userId: "u", durationMin: "5m" },
      "--duration-min",
    ],
    ["ban delete days", "ban", { guildId: "g", userId: "u", deleteDays: "7d" }, "--delete-days"],
    ["read limit", "read", { channel: "discord", target: "123", limit: "10x" }, "--limit"],
    ["search limit", "search", { guildId: "g", query: "hello", limit: "10x" }, "--limit"],
    ["pins limit", "list-pins", { channel: "discord", target: "123", limit: "10x" }, "--limit"],
    [
      "reactions limit",
      "reactions",
      { channel: "discord", target: "123", messageId: "m", limit: "10x" },
      "--limit",
    ],
    [
      "thread auto archive minutes",
      "thread-create",
      {
        channel: "discord",
        target: "123",
        threadName: "ops",
        autoArchiveMin: "60m",
      },
      "--auto-archive-min",
    ],
    ["thread list limit", "thread-list", { guildId: "g", limit: "10x" }, "--limit"],
  ])("rejects malformed numeric CLI option for %s", async (_name, action, opts, flag) => {
    const runMessageAction = createRunMessageAction();

    await expect(runMessageAction(action, opts)).rejects.toThrow("exit");

    const kind = NON_NEGATIVE_INTEGER_FLAGS.has(flag) ? "non-negative" : "positive";
    expect(errorMock).toHaveBeenCalledWith(`${flag} must be a ${kind} integer.`);
    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
    expect(messageCommandMock).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(exitMock).not.toHaveBeenCalledWith(0);
  });

  it.each([
    ["pollDurationHours", "0", "--poll-duration-hours"],
    ["pollDurationSeconds", "-1", "--poll-duration-seconds"],
    ["durationMin", "", "--duration-min"],
    ["deleteDays", Number.NaN, "--delete-days"],
    ["limit", 1.2, "--limit"],
    ["autoArchiveMin", null, "--auto-archive-min"],
  ])("rejects non-positive or non-integer %s values", async (key, value, flag) => {
    const runMessageAction = createRunMessageAction();

    await expect(
      runMessageAction("send", {
        ...baseSendOptions,
        [key]: value,
      }),
    ).rejects.toThrow("exit");

    const kind = NON_NEGATIVE_INTEGER_FLAGS.has(flag) ? "non-negative" : "positive";
    expect(errorMock).toHaveBeenCalledWith(`${flag} must be a ${kind} integer.`);
    expect(messageCommandMock).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("allows zero delete-days for no-history Discord bans", async () => {
    const runMessageAction = createRunMessageAction();

    await expect(
      runMessageAction("ban", {
        guildId: "g",
        userId: "u",
        deleteDays: "0",
      }),
    ).rejects.toThrow("exit");

    expect(errorMock).not.toHaveBeenCalled();
    expectMessageCommandOptions({
      action: "ban",
      guildId: "g",
      userId: "u",
      deleteDays: "0",
    });
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("allows zero duration-min for clearing Discord timeouts", async () => {
    const runMessageAction = createRunMessageAction();

    await expect(
      runMessageAction("timeout", {
        guildId: "g",
        userId: "u",
        durationMin: "0",
      }),
    ).rejects.toThrow("exit");

    expect(errorMock).not.toHaveBeenCalled();
    expectMessageCommandOptions({
      action: "timeout",
      guildId: "g",
      userId: "u",
      durationMin: "0",
    });
    expect(exitMock).toHaveBeenCalledWith(0);
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
      runGatewayStopMock.mockImplementationOnce(() => new Promise(() => {}));
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

    expect(errorMock).toHaveBeenCalledWith("send failed");
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

  it("runs gateway_stop hooks before exit(1) for a failed broadcast result", async () => {
    const order: string[] = [];
    hasHooksMock.mockReturnValueOnce(true);
    messageCommandMock.mockResolvedValueOnce({
      kind: "broadcast",
      channel: "telegram",
      action: "broadcast",
      handledBy: "core",
      payload: {
        results: [
          { channel: "telegram", to: "123", ok: true },
          { channel: "telegram", to: "456", ok: false, error: "delivery failed" },
        ],
      },
      dryRun: false,
    });
    runGatewayStopMock.mockImplementationOnce(async () => {
      order.push("stop");
    });
    exitMock.mockImplementationOnce((code: number): never => {
      order.push(`exit:${code}`);
      throw new Error("exit");
    });
    const runMessageAction = createRunMessageAction();

    await expect(
      runMessageAction("broadcast", {
        channel: "telegram",
        targets: ["123", "456"],
        message: "hi",
      }),
    ).rejects.toThrow("exit");

    expect(order).toEqual(["stop", "exit:1"]);
    expect(exitMock).not.toHaveBeenCalledWith(0);
  });

  it("logs gateway_stop failure and still exits with success code", async () => {
    hasHooksMock.mockReturnValueOnce(true);
    runGatewayStopMock.mockRejectedValueOnce(new Error("hook failed"));
    await runSendAction();

    expect(errorMock).toHaveBeenCalledWith("gateway_stop hook failed: hook failed");
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("logs gateway_stop failure and preserves failure exit code when send fails", async () => {
    hasHooksMock.mockReturnValueOnce(true);
    messageCommandMock.mockRejectedValueOnce(new Error("send failed"));
    runGatewayStopMock.mockRejectedValueOnce(new Error("hook failed"));
    await runSendAction();

    expect(errorMock).toHaveBeenNthCalledWith(1, "send failed");
    expect(errorMock).toHaveBeenNthCalledWith(2, "gateway_stop hook failed: hook failed");
    expect(exitMock).toHaveBeenCalledWith(1);
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
