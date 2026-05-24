import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordVoiceManager } from "./manager.js";
import {
  discordVoiceMeetingNotesSourceProvider,
  setDiscordMeetingNotesVoiceManager,
} from "./meeting-notes-source.js";

describe("discordVoiceMeetingNotesSourceProvider", () => {
  afterEach(() => {
    setDiscordMeetingNotesVoiceManager({ accountId: "primary", manager: null });
    setDiscordMeetingNotesVoiceManager({ accountId: "delayed", manager: null });
    vi.useRealTimers();
  });

  it("starts Discord voice in meeting-notes mode", async () => {
    const join = vi.fn(async () => ({ ok: true, message: "joined" }));
    setDiscordMeetingNotesVoiceManager({
      accountId: "primary",
      manager: { join } as unknown as DiscordVoiceManager,
    });

    const onUtterance = vi.fn();
    const result = await discordVoiceMeetingNotesSourceProvider.start?.({
      session: {
        sessionId: "notes-1",
        startedAt: new Date().toISOString(),
        source: {
          providerId: "discord-voice",
          accountId: "primary",
          guildId: "g1",
          channelId: "c1",
        },
      },
      onUtterance,
    });

    expect(result).toMatchObject({ ok: true });
    expect(join).toHaveBeenCalledWith(
      { guildId: "g1", channelId: "c1" },
      {
        meetingNotes: {
          sessionId: "notes-1",
          onUtterance,
        },
      },
    );
  });

  it("waits for a deferred voice manager during startup", async () => {
    vi.useFakeTimers();
    const join = vi.fn(async () => ({ ok: true, message: "joined" }));
    const onUtterance = vi.fn();
    const resultPromise = discordVoiceMeetingNotesSourceProvider.start?.({
      session: {
        sessionId: "notes-2",
        startedAt: new Date().toISOString(),
        source: {
          providerId: "discord-voice",
          accountId: "delayed",
          guildId: "g1",
          channelId: "c1",
        },
      },
      startupWaitMs: 30_000,
      onUtterance,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(join).not.toHaveBeenCalled();

    setDiscordMeetingNotesVoiceManager({
      accountId: "delayed",
      manager: { join } as unknown as DiscordVoiceManager,
    });

    await expect(resultPromise).resolves.toMatchObject({ ok: true });
    expect(join).toHaveBeenCalledTimes(1);
  });

  it("fails promptly without an explicit startup wait", async () => {
    const result = await discordVoiceMeetingNotesSourceProvider.start?.({
      session: {
        sessionId: "notes-3",
        startedAt: new Date().toISOString(),
        source: {
          providerId: "discord-voice",
          accountId: "primary",
          guildId: "g1",
          channelId: "c1",
        },
      },
      onUtterance: vi.fn(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Discord voice manager is not available.",
    });
  });

  it("stops Discord meeting notes without owning promoted voice sessions", async () => {
    const leave = vi.fn(async () => ({ ok: true, message: "stopped notes" }));
    setDiscordMeetingNotesVoiceManager({
      accountId: "primary",
      manager: { leave } as unknown as DiscordVoiceManager,
    });

    const result = await discordVoiceMeetingNotesSourceProvider.stop?.({
      sessionId: "notes-1",
      source: {
        providerId: "discord-voice",
        accountId: "primary",
        guildId: "g1",
        channelId: "c1",
      },
    });

    expect(result).toMatchObject({ ok: true, sessionId: "notes-1" });
    expect(leave).toHaveBeenCalledWith(
      {
        guildId: "g1",
        channelId: "c1",
      },
      {
        meetingNotesSessionId: "notes-1",
      },
    );
  });
});
