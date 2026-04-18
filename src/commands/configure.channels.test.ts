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

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Remove which channel config?",
        options: [
          expect.objectContaining({ value: channelChoice("telegram"), label: "Telegram" }),
          expect.objectContaining({ value: channelChoice("twitch"), label: "Twitch" }),
          expect.objectContaining({ value: channelChoice("unknown"), label: "unknown" }),
          { value: doneChoice, label: "Done" },
        ],
      }),
    );
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

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Delete Telegram configuration from ~/.openclaw/openclaw.json?",
      }),
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

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Delete done configuration from ~/.openclaw/openclaw.json?",
      }),
    );
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

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          expect.objectContaining({ value: channelChoice("telegram"), label: "Telegram" }),
          { value: doneChoice, label: "Done" },
        ],
      }),
    );
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

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({ value: channelChoice("telegram"), label: "Telegram\\nBot" }),
        ]),
      }),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Delete Telegram\\nBot configuration from ~/.openclaw/openclaw.json?",
      }),
    );
    expect(note).toHaveBeenCalledWith(
      "Telegram\\nBot removed from config.\nNote: credentials/sessions on disk are unchanged.",
      "Channel removed",
    );
  });

  it("sanitizes unknown channel keys before rendering prompts", async () => {
    const unsafeChannel = "bad\u001B[31m\nkey\u0007";
    select.mockResolvedValueOnce(channelChoice(unsafeChannel)).mockResolvedValueOnce(doneChoice);

    const next = await removeChannelConfigWizard(
      {
        channels: {
          [unsafeChannel]: { token: "secret" },
          telegram: { token: "secret" },
        },
      } as never,
      {} as never,
    );

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({ value: channelChoice(unsafeChannel), label: "bad\\nkey" }),
        ]),
      }),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Delete bad\\nkey configuration from ~/.openclaw/openclaw.json?",
      }),
    );
    expect(next.channels).toEqual({ telegram: { token: "secret" } });
    expect(note).toHaveBeenCalledWith(
      "bad\\nkey removed from config.\nNote: credentials/sessions on disk are unchanged.",
      "Channel removed",
    );
  });

  it("uses a placeholder when an unknown channel key sanitizes to empty", async () => {
    const unsafeChannel = "\u001B[31m\u0007";
    select.mockResolvedValueOnce(channelChoice(unsafeChannel)).mockResolvedValueOnce(doneChoice);

    const next = await removeChannelConfigWizard(
      {
        channels: {
          [unsafeChannel]: { token: "secret" },
          telegram: { token: "secret" },
        },
      } as never,
      {} as never,
    );

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({
            value: channelChoice(unsafeChannel),
            label: "<invalid channel key>",
          }),
        ]),
      }),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Delete <invalid channel key> configuration from ~/.openclaw/openclaw.json?",
      }),
    );
    expect(next.channels).toEqual({ telegram: { token: "secret" } });
    expect(note).toHaveBeenCalledWith(
      "<invalid channel key> removed from config.\nNote: credentials/sessions on disk are unchanged.",
      "Channel removed",
    );
  });
});
