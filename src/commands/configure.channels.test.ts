import { beforeEach, describe, expect, it, vi } from "vitest";

const select = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
const note = vi.hoisted(() => vi.fn());
const chatChannels = vi.hoisted(() =>
  vi.fn(() => [
    { id: "telegram", label: "Telegram" },
    { id: "twitch", label: "Twitch" },
  ]),
);

vi.mock("../channels/chat-meta.js", () => ({
  listChatChannels: () => chatChannels(),
}));

vi.mock("../terminal/note.js", () => ({
  note: (...args: unknown[]) => note(...args),
}));

vi.mock("./configure.shared.js", () => ({
  select: (params: unknown) => select(params),
  confirm: (params: unknown) => confirm(params),
}));

import { removeChannelConfigWizard } from "./configure.channels.js";

const channelChoice = (id: string) => ({ kind: "channel" as const, id });
const doneChoice = { kind: "done" as const };

async function removeUnsafeChannelConfig(unsafeChannel: string) {
  select.mockResolvedValueOnce(channelChoice(unsafeChannel)).mockResolvedValueOnce(doneChoice);

  return removeChannelConfigWizard(
    {
      channels: {
        [unsafeChannel]: { token: "secret" },
        telegram: { token: "secret" },
      },
    } as never,
    {} as never,
  );
}

function selectArg(index = 0): {
  message?: string;
  options?: Array<{ value: unknown; label: string }>;
} {
  const call = select.mock.calls[index];
  if (!call) {
    throw new Error(`Expected select call ${index}`);
  }
  return call[0] as { message?: string; options?: Array<{ value: unknown; label: string }> };
}

function confirmArg(index = 0): { message?: string } {
  const call = confirm.mock.calls[index];
  if (!call) {
    throw new Error(`Expected confirm call ${index}`);
  }
  return call[0] as { message?: string };
}

function expectOption(
  options: Array<{ value: unknown; label: string }> | undefined,
  value: unknown,
  label: string,
) {
  expect(
    options?.some(
      (option) => option.label === label && JSON.stringify(option.value) === JSON.stringify(value),
    ),
  ).toBe(true);
}

function optionLabels(options: Array<{ value: unknown; label: string }> | undefined) {
  return options?.map((option) => ({ value: option.value, label: option.label }));
}

function expectUnknownChannelRemovalPrompt(unsafeChannel: string, label: string) {
  expectOption(selectArg().options, channelChoice(unsafeChannel), label);
  expect(confirmArg().message).toBe(
    `Delete ${label} configuration from ~/.openclaw/openclaw.json?`,
  );
  expect(note).toHaveBeenCalledWith(
    `${label} removed from config.\nNote: credentials/sessions on disk are unchanged.`,
    "Channel removed",
  );
}

describe("removeChannelConfigWizard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    chatChannels.mockReturnValue([
      { id: "telegram", label: "Telegram" },
      { id: "twitch", label: "Twitch" },
    ]);
    confirm.mockResolvedValue(true);
  });

  it("lists configured channels from openclaw.json even when no plugins are loaded", async () => {
    select.mockResolvedValue(doneChoice);

    await removeChannelConfigWizard(
      {
        channels: {
          defaults: { groupPolicy: "open" },
          modelByChannel: { openai: { telegram: "gpt-5.4" } },
          twitch: {},
          unknown: {},
          telegram: {},
        },
      } as never,
      {} as never,
    );

    const prompt = selectArg();
    expect(prompt.message).toBe("Remove which channel config?");
    expect(optionLabels(prompt.options)).toEqual([
      { value: channelChoice("telegram"), label: "Telegram" },
      { value: channelChoice("twitch"), label: "Twitch" },
      { value: channelChoice("unknown"), label: "unknown" },
      { value: doneChoice, label: "Done" },
    ]);
  });

  it("deletes the selected channel block from openclaw.json", async () => {
    select.mockResolvedValueOnce(channelChoice("telegram")).mockResolvedValueOnce(doneChoice);

    const next = await removeChannelConfigWizard(
      {
        channels: {
          telegram: { token: "secret" },
          twitch: { token: "secret" },
        },
      } as never,
      {} as never,
    );

    expect(confirmArg().message).toBe(
      "Delete Telegram configuration from ~/.openclaw/openclaw.json?",
    );
    expect(next.channels).toEqual({ twitch: { token: "secret" } });
    expect(note).toHaveBeenCalledWith(
      "Telegram removed from config.\nNote: credentials/sessions on disk are unchanged.",
      "Channel removed",
    );
  });

  it("deletes a real channel block named done", async () => {
    select.mockResolvedValueOnce(channelChoice("done")).mockResolvedValueOnce(doneChoice);

    const next = await removeChannelConfigWizard(
      {
        channels: {
          done: { token: "secret" },
          telegram: { token: "secret" },
        },
      } as never,
      {} as never,
    );

    expect(confirmArg().message).toBe("Delete done configuration from ~/.openclaw/openclaw.json?");
    expect(next.channels).toEqual({ telegram: { token: "secret" } });
    expect(note).toHaveBeenCalledWith(
      "done removed from config.\nNote: credentials/sessions on disk are unchanged.",
      "Channel removed",
    );
  });

  it("preserves channel-wide defaults when deleting the last channel block", async () => {
    select.mockResolvedValueOnce(channelChoice("telegram")).mockResolvedValueOnce(doneChoice);

    const next = await removeChannelConfigWizard(
      {
        channels: {
          defaults: { groupPolicy: "open" },
          modelByChannel: { openai: { telegram: "gpt-5.4" } },
          telegram: { token: "secret" },
        },
      } as never,
      {} as never,
    );

    expect(next.channels).toEqual({
      defaults: { groupPolicy: "open" },
      modelByChannel: { openai: { telegram: "gpt-5.4" } },
    });
  });

  it("does not list blocked object keys as removable channels", async () => {
    select.mockResolvedValue(doneChoice);

    await removeChannelConfigWizard(
      {
        channels: {
          __proto__: { token: "secret" },
          constructor: { token: "secret" },
          prototype: { token: "secret" },
          telegram: { token: "secret" },
        },
      } as never,
      {} as never,
    );

    expect(optionLabels(selectArg().options)).toEqual([
      { value: channelChoice("telegram"), label: "Telegram" },
      { value: doneChoice, label: "Done" },
    ]);
  });

  it("sanitizes known channel labels before rendering prompts", async () => {
    chatChannels.mockReturnValue([
      { id: "telegram", label: "Telegram\u001B[31m\nBot\u0007" },
      { id: "twitch", label: "Twitch" },
    ]);
    select.mockResolvedValueOnce(channelChoice("telegram")).mockResolvedValueOnce(doneChoice);

    await removeChannelConfigWizard(
      {
        channels: {
          telegram: { token: "secret" },
        },
      } as never,
      {} as never,
    );

    expectOption(selectArg().options, channelChoice("telegram"), "Telegram\\nBot");
    expect(confirmArg().message).toBe(
      "Delete Telegram\\nBot configuration from ~/.openclaw/openclaw.json?",
    );
    expect(note).toHaveBeenCalledWith(
      "Telegram\\nBot removed from config.\nNote: credentials/sessions on disk are unchanged.",
      "Channel removed",
    );
  });

  it("sanitizes unknown channel keys before rendering prompts", async () => {
    const unsafeChannel = "bad\u001B[31m\nkey\u0007";
    const next = await removeUnsafeChannelConfig(unsafeChannel);

    expectUnknownChannelRemovalPrompt(unsafeChannel, "bad\\nkey");
    expect(next.channels).toEqual({ telegram: { token: "secret" } });
  });

  it("uses a placeholder when an unknown channel key sanitizes to empty", async () => {
    const unsafeChannel = "\u001B[31m\u0007";
    const next = await removeUnsafeChannelConfig(unsafeChannel);

    expectUnknownChannelRemovalPrompt(unsafeChannel, "<invalid channel key>");
    expect(next.channels).toEqual({ telegram: { token: "secret" } });
  });
});
