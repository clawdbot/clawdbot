// Register message tests cover message command registration in the CLI program.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgramContext } from "./context.js";
import { registerMessageCommands } from "./register.message.js";

const mocks = vi.hoisted(() => ({
  createMessageCliHelpersMock: vi.fn(() => ({ helper: true })),
  registerMessageSendCommandMock: vi.fn(),
  registerMessageBroadcastCommandMock: vi.fn(),
  registerMessagePollCommandMock: vi.fn(),
  registerMessageReactionsCommandsMock: vi.fn(),
  registerMessageReadEditDeleteCommandsMock: vi.fn(),
  registerMessagePinCommandsMock: vi.fn(),
  registerMessagePermissionsCommandMock: vi.fn(),
  registerMessageSearchCommandMock: vi.fn(),
  registerMessageThreadCommandsMock: vi.fn(),
  registerMessageEmojiCommandsMock: vi.fn(),
  registerMessageStickerCommandsMock: vi.fn(),
  registerMessageDiscordAdminCommandsMock: vi.fn(),
}));

const createMessageCliHelpersMock = mocks.createMessageCliHelpersMock;
const registerMessageSendCommandMock = mocks.registerMessageSendCommandMock;
const registerMessageBroadcastCommandMock = mocks.registerMessageBroadcastCommandMock;
const registerMessagePollCommandMock = mocks.registerMessagePollCommandMock;
const registerMessageReactionsCommandsMock = mocks.registerMessageReactionsCommandsMock;
const registerMessageReadEditDeleteCommandsMock = mocks.registerMessageReadEditDeleteCommandsMock;
const registerMessagePinCommandsMock = mocks.registerMessagePinCommandsMock;
const registerMessagePermissionsCommandMock = mocks.registerMessagePermissionsCommandMock;
const registerMessageSearchCommandMock = mocks.registerMessageSearchCommandMock;
const registerMessageThreadCommandsMock = mocks.registerMessageThreadCommandsMock;
const registerMessageEmojiCommandsMock = mocks.registerMessageEmojiCommandsMock;
const registerMessageStickerCommandsMock = mocks.registerMessageStickerCommandsMock;
const registerMessageDiscordAdminCommandsMock = mocks.registerMessageDiscordAdminCommandsMock;

function requireProgramCommand(program: Command, name: string): Command {
  const command = program.commands.find((entry) => entry.name() === name);
  if (!command) {
    throw new Error(`expected ${name} command`);
  }
  return command;
}

vi.mock("./message/helpers.js", () => ({
  createMessageCliHelpers: mocks.createMessageCliHelpersMock,
}));

vi.mock("./message/register.send.js", () => ({
  registerMessageSendCommand: mocks.registerMessageSendCommandMock,
}));

vi.mock("./message/register.broadcast.js", () => ({
  registerMessageBroadcastCommand: mocks.registerMessageBroadcastCommandMock,
}));

vi.mock("./message/register.poll.js", () => ({
  registerMessagePollCommand: mocks.registerMessagePollCommandMock,
}));

vi.mock("./message/register.reactions.js", () => ({
  registerMessageReactionsCommands: mocks.registerMessageReactionsCommandsMock,
}));

vi.mock("./message/register.read-edit-delete.js", () => ({
  registerMessageReadEditDeleteCommands: mocks.registerMessageReadEditDeleteCommandsMock,
}));

vi.mock("./message/register.pins.js", () => ({
  registerMessagePinCommands: mocks.registerMessagePinCommandsMock,
}));

vi.mock("./message/register.permissions-search.js", () => ({
  registerMessagePermissionsCommand: mocks.registerMessagePermissionsCommandMock,
  registerMessageSearchCommand: mocks.registerMessageSearchCommandMock,
}));

vi.mock("./message/register.thread.js", () => ({
  registerMessageThreadCommands: mocks.registerMessageThreadCommandsMock,
}));

vi.mock("./message/register.emoji-sticker.js", () => ({
  registerMessageEmojiCommands: mocks.registerMessageEmojiCommandsMock,
  registerMessageStickerCommands: mocks.registerMessageStickerCommandsMock,
}));

vi.mock("./message/register.discord-admin.js", () => ({
  registerMessageDiscordAdminCommands: mocks.registerMessageDiscordAdminCommandsMock,
}));

describe("registerMessageCommands", () => {
  const ctx: ProgramContext = {
    programVersion: "9.9.9-test",
    channelOptions: ["telegram", "discord"],
    messageChannelOptions: "telegram|discord",
    agentChannelOptions: "last|telegram|discord",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    createMessageCliHelpersMock.mockReturnValue({ helper: true });
  });

  it("registers message command and wires all message sub-registrars with shared helpers", () => {
    const program = new Command();
    registerMessageCommands(program, ctx);

    const message = requireProgramCommand(program, "message");
    expect(createMessageCliHelpersMock).toHaveBeenCalledWith("telegram|discord");

    const expectedRegistrars = [
      registerMessageSendCommandMock,
      registerMessageBroadcastCommandMock,
      registerMessagePollCommandMock,
      registerMessageReactionsCommandsMock,
      registerMessageReadEditDeleteCommandsMock,
      registerMessagePinCommandsMock,
      registerMessagePermissionsCommandMock,
      registerMessageSearchCommandMock,
      registerMessageThreadCommandsMock,
      registerMessageEmojiCommandsMock,
      registerMessageStickerCommandsMock,
      registerMessageDiscordAdminCommandsMock,
    ];
    for (const registrar of expectedRegistrars) {
      expect(registrar).toHaveBeenCalledWith(message, { helper: true });
    }
  });

  it("shows root message help without reporting a command failure", async () => {
    const program = new Command().exitOverride();
    registerMessageCommands(program, ctx);
    const message = requireProgramCommand(program, "message");
    const helpSpy = vi.spyOn(message, "outputHelp").mockImplementation(() => {});
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;

      await expect(program.parseAsync(["message"], { from: "user" })).resolves.toBe(program);

      expect(helpSpy).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it.each([
    ["thread", registerMessageThreadCommandsMock],
    ["emoji", registerMessageEmojiCommandsMock],
    ["sticker", registerMessageStickerCommandsMock],
    ["role", registerMessageDiscordAdminCommandsMock],
    ["channel", registerMessageDiscordAdminCommandsMock],
    ["member", registerMessageDiscordAdminCommandsMock],
    ["voice", registerMessageDiscordAdminCommandsMock],
    ["event", registerMessageDiscordAdminCommandsMock],
  ])("shows message %s help without reporting a command failure", async (name, registerCommand) => {
    registerCommand.mockImplementationOnce((message: Command) => {
      message
        .command(name)
        .command("action")
        .action(() => {});
    });
    const program = new Command().exitOverride();
    registerMessageCommands(program, ctx);
    const parent = requireProgramCommand(requireProgramCommand(program, "message"), name);
    const helpSpy = vi.spyOn(parent, "outputHelp").mockImplementation(() => {});
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;

      await expect(program.parseAsync(["message", name], { from: "user" })).resolves.toBe(program);

      expect(helpSpy).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});
