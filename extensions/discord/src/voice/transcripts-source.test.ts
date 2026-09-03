import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Discord tests cover transcripts source plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discordVoiceTranscriptsSourceProvider,
  setDiscordTranscriptsVoiceManager,
} from "./transcripts-source.js";
import type { DiscordVoiceManager } from "./voice-runtime.js";

describe("discordVoiceTranscriptsSourceProvider", () => {
  afterEach(() => {
    setDiscordTranscriptsVoiceManager({ accountId: "primary", manager: null });
    setDiscordTranscriptsVoiceManager({ accountId: "delayed", manager: null });
    setDiscordTranscriptsVoiceManager({ accountId: "work", manager: null });
    vi.useRealTimers();
  });

  it("declares Discord as its account ownership namespace", () => {
    expect(discordVoiceTranscriptsSourceProvider.accessControl?.channelId).toBe("discord");
  });

  it("authorizes the resolved target with the native voice policy", async () => {
    setDiscordTranscriptsVoiceManager({
      accountId: "primary",
      manager: {
        resolveAccessTarget: vi.fn(async () => ({
          guild: { id: "g1", name: "Guild One" },
          channelName: "General Voice",
          channelSlug: "general-voice",
          scope: "channel",
        })),
      } as unknown as DiscordVoiceManager,
    });
    const cfg = {
      channels: {
        discord: {
          accounts: {
            primary: {
              token: "token-primary",
              voice: { enabled: true },
              groupPolicy: "allowlist",
              guilds: {
                "guild-one": { channels: { "*": { users: ["discord:u-owner"] } } },
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    await expect(
      discordVoiceTranscriptsSourceProvider.accessControl?.authorize({
        action: "start",
        cfg,
        caller: {
          kind: "channel",
          channel: "discord",
          accountId: "primary",
          senderId: "u-owner",
          groupSpace: "g1",
          roleIds: [],
        },
        source: {
          providerId: "discord-voice",
          accountId: "primary",
          guildId: "g1",
          channelId: "c1",
        },
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
  });

  it("rejects channel callers whose account or guild does not own the target", async () => {
    const authorize = discordVoiceTranscriptsSourceProvider.accessControl?.authorize;
    if (!authorize) {
      throw new Error("expected Discord transcript access control");
    }
    const base = {
      action: "start" as const,
      cfg: {
        channels: {
          discord: {
            accounts: { primary: { token: "token-primary", voice: { enabled: true } } },
          },
        },
      },
      caller: {
        kind: "channel" as const,
        channel: "discord",
        accountId: "other",
        senderId: "u-owner",
        groupSpace: "g1",
        roleIds: [],
      },
      source: {
        providerId: "discord-voice",
        accountId: "primary",
        guildId: "g1",
        channelId: "c1",
      },
    };

    await expect(authorize(base)).resolves.toMatchObject({ ok: false });
    await expect(
      authorize({
        ...base,
        caller: { ...base.caller, accountId: "primary", groupSpace: "other-guild" },
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it.each([undefined, "Operator meeting"])(
    "starts capture, retains title %s, and reports retirement",
    async (title) => {
      const join = vi.fn<DiscordVoiceManager["join"]>(async () => ({
        ok: true,
        message: "joined",
        channelName: "Planning room",
      }));
      setDiscordTranscriptsVoiceManager({
        accountId: "primary",
        manager: { join } as unknown as DiscordVoiceManager,
      });

      const onUtterance = vi.fn();
      const onStatus = vi.fn();
      const result = await discordVoiceTranscriptsSourceProvider.start?.({
        session: {
          sessionId: "notes-1",
          title,
          startedAt: new Date().toISOString(),
          source: {
            providerId: "discord-voice",
            accountId: "primary",
            guildId: "g1",
            channelId: "c1",
          },
        },
        onUtterance,
        onStatus,
      });

      expect(result).toMatchObject({ ok: true, session: { title: title ?? "Planning room" } });
      expect(join).toHaveBeenCalledWith(
        { guildId: "g1", channelId: "c1" },
        {
          transcripts: {
            sessionId: "notes-1",
            onUtterance,
            onStop: expect.any(Function),
          },
        },
      );
      await join.mock.calls[0]?.[1]?.transcripts?.onStop?.();
      expect(onStatus).toHaveBeenCalledExactlyOnceWith({
        active: false,
        sessionId: "notes-1",
        source: {
          providerId: "discord-voice",
          accountId: "primary",
          guildId: "g1",
          channelId: "c1",
        },
      });
    },
  );

  it("uses the sole voice-capable account instead of a text-only default", async () => {
    const workJoin = vi.fn(async () => ({ ok: true, message: "joined work" }));
    setDiscordTranscriptsVoiceManager({
      accountId: "work",
      manager: { join: workJoin } as unknown as DiscordVoiceManager,
    });
    const source = {
      providerId: "discord-voice",
      guildId: "g1",
      channelId: "c1",
    };
    const cfg = {
      channels: {
        discord: {
          defaultAccount: "primary",
          accounts: {
            primary: { token: "token-primary", voice: { enabled: false } },
            work: { token: "token-work", voice: { enabled: true } },
          },
        },
      },
    };

    const accountResolution = discordVoiceTranscriptsSourceProvider.accessControl?.resolveAccountId(
      {
        cfg,
        source,
      },
    );
    expect(accountResolution).toEqual({ ok: true, value: "work" });
    const result = await discordVoiceTranscriptsSourceProvider.start?.({
      cfg,
      session: {
        sessionId: "notes-default",
        startedAt: new Date().toISOString(),
        source: {
          ...source,
          accountId: accountResolution?.ok ? accountResolution.value : undefined,
        },
      },
      onUtterance: vi.fn(),
    });

    expect(result).toMatchObject({ ok: true });
    expect(workJoin).toHaveBeenCalledOnce();
  });

  it("uses the configured or canonical default when multiple accounts can provide voice", () => {
    const source = {
      providerId: "discord-voice",
      guildId: "g1",
      channelId: "c1",
    };
    const cfg = {
      channels: {
        discord: {
          defaultAccount: "primary",
          accounts: {
            primary: { token: "a", voice: { enabled: true } },
            work: { token: "b", voice: { enabled: true } },
          },
        },
      },
    };

    expect(
      discordVoiceTranscriptsSourceProvider.accessControl?.resolveAccountId({ cfg, source }),
    ).toEqual({
      ok: true,
      value: "primary",
    });
    expect(
      discordVoiceTranscriptsSourceProvider.accessControl?.resolveAccountId({
        cfg,
        source: { ...source, accountId: "work" },
      }),
    ).toEqual({ ok: true, value: "work" });

    expect(
      discordVoiceTranscriptsSourceProvider.accessControl?.resolveAccountId({
        cfg: {
          channels: {
            discord: {
              accounts: {
                default: { token: "a", voice: { enabled: true } },
                work: { token: "b", voice: { enabled: true } },
              },
            },
          },
        },
        source,
      }),
    ).toEqual({ ok: true, value: "default" });
  });

  it("rejects omitted and explicit accounts that cannot provide voice", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            primary: { token: "a", voice: { enabled: false } },
          },
        },
      },
    };
    const source = { providerId: "discord-voice", guildId: "g1", channelId: "c1" };

    expect(
      discordVoiceTranscriptsSourceProvider.accessControl?.resolveAccountId({ cfg, source }),
    ).toEqual({
      ok: false,
      error:
        "No Discord account has available credentials and voice enabled; configure credentials and enable voice for an account.",
    });
    expect(
      discordVoiceTranscriptsSourceProvider.accessControl?.resolveAccountId({
        cfg,
        source: { ...source, accountId: "primary" },
      }),
    ).toEqual({ ok: false, error: 'Discord account "primary" is not enabled for voice.' });
  });

  it("excludes voice accounts whose configured credentials are unavailable", async () => {
    const primaryJoin = vi.fn(async () => ({ ok: true, message: "joined primary" }));
    setDiscordTranscriptsVoiceManager({
      accountId: "primary",
      manager: { join: primaryJoin } as unknown as DiscordVoiceManager,
    });
    const unavailableAccount = {
      token: { source: "env", provider: "default", id: "DISCORD_WORK_TOKEN" },
      voice: { enabled: true },
    };
    const cfg = {
      channels: {
        discord: {
          accounts: {
            primary: { token: "available-token", voice: { enabled: true } },
            work: unavailableAccount,
          },
        },
      },
    } as unknown as OpenClawConfig;
    const source = { providerId: "discord-voice", guildId: "g1", channelId: "c1" };

    expect(
      discordVoiceTranscriptsSourceProvider.accessControl?.resolveAccountId({ cfg, source }),
    ).toEqual({
      ok: true,
      value: "primary",
    });
    expect(
      discordVoiceTranscriptsSourceProvider.accessControl?.resolveAccountId({
        cfg,
        source: { ...source, accountId: "work" },
      }),
    ).toEqual({
      ok: false,
      error:
        'Discord account "work" has configured credentials that are unavailable in this runtime; resolve its SecretRef before using this account.',
    });
    await expect(
      discordVoiceTranscriptsSourceProvider.start?.({
        cfg,
        session: {
          sessionId: "unavailable-account",
          startedAt: new Date().toISOString(),
          source: { ...source, accountId: "work" },
        },
        onUtterance: vi.fn(),
      }),
    ).resolves.toEqual({
      ok: false,
      error:
        'Discord account "work" has configured credentials that are unavailable in this runtime; resolve its SecretRef before using this account.',
    });
    expect(primaryJoin).not.toHaveBeenCalled();

    const unavailableOnly = {
      channels: { discord: { accounts: { work: unavailableAccount } } },
    } as unknown as OpenClawConfig;
    expect(
      discordVoiceTranscriptsSourceProvider.accessControl?.resolveAccountId({
        cfg: unavailableOnly,
        source,
      }),
    ).toEqual({
      ok: false,
      error:
        "No Discord account has available credentials and voice enabled; configure credentials and enable voice for an account.",
    });
  });

  it("bounds account identifiers in resolution errors", () => {
    const accounts = Object.fromEntries(
      ["alpha", "bravo", "charlie", "delta", "echo"].map((accountId) => [
        accountId,
        { token: `token-${accountId}`, voice: { enabled: true } },
      ]),
    );
    const cfg = { channels: { discord: { accounts } } };
    const source = { providerId: "discord-voice", guildId: "g1", channelId: "c1" };

    const ambiguous = discordVoiceTranscriptsSourceProvider.accessControl?.resolveAccountId({
      cfg,
      source,
    });
    expect(ambiguous).toMatchObject({ ok: false });
    if (!ambiguous || ambiguous.ok) {
      throw new Error("expected ambiguous account resolution");
    }
    expect(ambiguous.error).toContain("(+1)");

    const rejected = discordVoiceTranscriptsSourceProvider.accessControl?.resolveAccountId({
      cfg,
      source: { ...source, accountId: `${"z".repeat(200)}\nspoofed` },
    });
    expect(rejected).toMatchObject({ ok: false });
    if (!rejected || rejected.ok) {
      throw new Error("expected rejected account resolution");
    }
    expect(rejected.error).not.toContain("z".repeat(65));
    expect(rejected.error).not.toContain("\nspoofed");
  });

  it("waits for the sole configured voice account's manager during startup", async () => {
    vi.useFakeTimers();
    const join = vi.fn(async () => ({ ok: true, message: "joined" }));
    const onUtterance = vi.fn();
    const resultPromise = discordVoiceTranscriptsSourceProvider.start?.({
      cfg: {
        channels: {
          discord: {
            accounts: { delayed: { token: "token-delayed", voice: { enabled: true } } },
          },
        },
      },
      session: {
        sessionId: "notes-2",
        startedAt: new Date().toISOString(),
        source: {
          providerId: "discord-voice",
          guildId: "g1",
          channelId: "c1",
        },
      },
      startupWaitMs: 30_000,
      onUtterance,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(join).not.toHaveBeenCalled();

    setDiscordTranscriptsVoiceManager({
      accountId: "delayed",
      manager: { join } as unknown as DiscordVoiceManager,
    });

    await expect(resultPromise).resolves.toMatchObject({ ok: true });
    expect(join).toHaveBeenCalledTimes(1);
  });

  it("fails promptly without an explicit startup wait", async () => {
    const result = await discordVoiceTranscriptsSourceProvider.start?.({
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

  it.each(["registered", "delayed"])(
    "watches occupancy through the %s voice-capable account and stops callbacks",
    async (readiness) => {
      vi.useFakeTimers();
      let listener: ((state: { occupied: boolean }) => void) | undefined;
      const unsubscribe = vi.fn(() => {
        listener = undefined;
      });
      const watchChannelOccupancy = vi.fn<DiscordVoiceManager["watchChannelOccupancy"]>(
        (_room, callback) => {
          listener = callback;
          callback({ occupied: true });
          return unsubscribe;
        },
      );
      const manager = { watchChannelOccupancy } as unknown as DiscordVoiceManager;
      if (readiness === "registered") {
        setDiscordTranscriptsVoiceManager({ accountId: "work", manager });
      }
      const transitions: string[] = [];
      const request = discordVoiceTranscriptsSourceProvider.watchOccupancy?.({
        cfg: {
          channels: {
            discord: {
              defaultAccount: "primary",
              accounts: {
                primary: { token: "primary-token", voice: { enabled: false } },
                work: { token: "work-token", voice: { enabled: true } },
              },
            },
          },
        },
        source: { providerId: "discord-voice", guildId: "g1", channelId: "c1" },
        startupWaitMs: 30_000,
        onOccupied: () => {
          transitions.push("occupied");
        },
        onEmpty: () => {
          transitions.push("empty");
        },
      });
      if (readiness === "delayed") {
        await vi.advanceTimersByTimeAsync(1_000);
        expect(transitions).toEqual([]);
        setDiscordTranscriptsVoiceManager({ accountId: "work", manager });
      }
      const result = await request;
      expect(result?.ok).toBe(true);
      expect(watchChannelOccupancy).toHaveBeenCalledWith(
        { guildId: "g1", channelId: "c1" },
        expect.any(Function),
      );
      listener?.({ occupied: false });
      expect(transitions).toEqual(["occupied", "empty"]);
      if (!result?.ok) {
        throw new Error("expected occupancy watch handle");
      }
      result.value.stop();
      listener?.({ occupied: true });
      expect(transitions).toEqual(["occupied", "empty"]);
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["abort", "timeout"])(
    "releases a manager wait on %s without subscribing later",
    async (ending) => {
      vi.useFakeTimers();
      const abortController = new AbortController();
      const watchChannelOccupancy = vi.fn();
      const result = discordVoiceTranscriptsSourceProvider.watchOccupancy?.({
        source: {
          providerId: "discord-voice",
          accountId: "delayed",
          guildId: "g1",
          channelId: "c1",
        },
        startupWaitMs: 1_000,
        abortSignal: abortController.signal,
        onOccupied: vi.fn(),
        onEmpty: vi.fn(),
      });
      if (ending === "abort") {
        abortController.abort();
      } else {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await expect(result).resolves.toMatchObject({ ok: false });
      setDiscordTranscriptsVoiceManager({
        accountId: "delayed",
        manager: { watchChannelOccupancy } as unknown as DiscordVoiceManager,
      });
      expect(watchChannelOccupancy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("stops Discord transcripts without owning promoted voice sessions", async () => {
    const leave = vi.fn(async () => ({ ok: true, message: "stopped notes" }));
    setDiscordTranscriptsVoiceManager({
      accountId: "primary",
      manager: { leave } as unknown as DiscordVoiceManager,
    });

    const result = await discordVoiceTranscriptsSourceProvider.stop?.({
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
        transcriptsSessionId: "notes-1",
      },
    );
  });

  it("does not route accountless lifecycle calls to an arbitrary voice manager", async () => {
    const leave = vi.fn(async () => ({ ok: true, message: "stopped notes" }));
    const status = vi.fn(() => [{ ok: true, message: "active", guildId: "g1" }]);
    setDiscordTranscriptsVoiceManager({
      accountId: "primary",
      manager: { leave, status } as unknown as DiscordVoiceManager,
    });
    const source = { providerId: "discord-voice", guildId: "g1", channelId: "c1" };

    await expect(
      discordVoiceTranscriptsSourceProvider.stop?.({ sessionId: "legacy-notes", source }),
    ).resolves.toEqual({
      ok: false,
      error: "Discord transcripts require accountId to stop a voice session.",
    });
    await expect(discordVoiceTranscriptsSourceProvider.status?.(source)).resolves.toEqual([]);
    expect(leave).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
});
