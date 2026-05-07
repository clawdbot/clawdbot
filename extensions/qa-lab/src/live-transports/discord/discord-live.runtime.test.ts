import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
  findMissingLiveTransportStandardScenarios,
} from "../shared/live-transport-scenarios.js";
import { __testing } from "./discord-live.runtime.js";

describe("discord live qa runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resolves required Discord QA env vars", () => {
    expect(
      __testing.resolveDiscordQaRuntimeEnv({
        OPENCLAW_QA_DISCORD_GUILD_ID: "123456789012345678",
        OPENCLAW_QA_DISCORD_CHANNEL_ID: "223456789012345678",
        OPENCLAW_QA_DISCORD_DRIVER_BOT_TOKEN: "driver",
        OPENCLAW_QA_DISCORD_SUT_BOT_TOKEN: "sut",
        OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID: "323456789012345678",
      }),
    ).toEqual({
      guildId: "123456789012345678",
      channelId: "223456789012345678",
      driverBotToken: "driver",
      sutBotToken: "sut",
      sutApplicationId: "323456789012345678",
    });
  });

  it("resolves optional Discord QA voice channel env var", () => {
    expect(
      __testing.resolveDiscordQaRuntimeEnv({
        OPENCLAW_QA_DISCORD_GUILD_ID: "123456789012345678",
        OPENCLAW_QA_DISCORD_CHANNEL_ID: "223456789012345678",
        OPENCLAW_QA_DISCORD_VOICE_CHANNEL_ID: "523456789012345678",
        OPENCLAW_QA_DISCORD_DRIVER_BOT_TOKEN: "driver",
        OPENCLAW_QA_DISCORD_SUT_BOT_TOKEN: "sut",
        OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID: "323456789012345678",
      }),
    ).toEqual({
      guildId: "123456789012345678",
      channelId: "223456789012345678",
      voiceChannelId: "523456789012345678",
      driverBotToken: "driver",
      sutBotToken: "sut",
      sutApplicationId: "323456789012345678",
    });
  });

  it("fails when a required Discord QA env var is missing", () => {
    expect(() =>
      __testing.resolveDiscordQaRuntimeEnv({
        OPENCLAW_QA_DISCORD_GUILD_ID: "123456789012345678",
        OPENCLAW_QA_DISCORD_CHANNEL_ID: "223456789012345678",
        OPENCLAW_QA_DISCORD_DRIVER_BOT_TOKEN: "driver",
        OPENCLAW_QA_DISCORD_SUT_BOT_TOKEN: "sut",
      }),
    ).toThrow("OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID");
  });

  it("fails when Discord IDs are not snowflakes", () => {
    expect(() =>
      __testing.resolveDiscordQaRuntimeEnv({
        OPENCLAW_QA_DISCORD_GUILD_ID: "qa-guild",
        OPENCLAW_QA_DISCORD_CHANNEL_ID: "223456789012345678",
        OPENCLAW_QA_DISCORD_DRIVER_BOT_TOKEN: "driver",
        OPENCLAW_QA_DISCORD_SUT_BOT_TOKEN: "sut",
        OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID: "323456789012345678",
      }),
    ).toThrow("OPENCLAW_QA_DISCORD_GUILD_ID must be a Discord snowflake.");
  });

  it("parses Discord pooled credential payloads", () => {
    expect(
      __testing.parseDiscordQaCredentialPayload({
        guildId: "123456789012345678",
        channelId: "223456789012345678",
        voiceChannelId: "523456789012345678",
        driverBotToken: "driver",
        sutBotToken: "sut",
        sutApplicationId: "323456789012345678",
      }),
    ).toEqual({
      guildId: "123456789012345678",
      channelId: "223456789012345678",
      voiceChannelId: "523456789012345678",
      driverBotToken: "driver",
      sutBotToken: "sut",
      sutApplicationId: "323456789012345678",
    });
  });

  it("rejects Discord pooled credential payloads with bad snowflakes", () => {
    expect(() =>
      __testing.parseDiscordQaCredentialPayload({
        guildId: "123456789012345678",
        channelId: "channel",
        driverBotToken: "driver",
        sutBotToken: "sut",
        sutApplicationId: "323456789012345678",
      }),
    ).toThrow("Discord credential payload_CHANNEL_ID must be a Discord snowflake.");
  });

  it("injects a temporary Discord account into the QA gateway config", () => {
    const baseCfg: OpenClawConfig = {
      plugins: {
        allow: ["memory-core", "qa-channel"],
        entries: {
          "memory-core": { enabled: true },
          "qa-channel": { enabled: true },
        },
      },
      channels: {
        "qa-channel": {
          enabled: true,
          baseUrl: "http://127.0.0.1:43123",
          botUserId: "openclaw",
          botDisplayName: "OpenClaw QA",
          allowFrom: ["*"],
        },
      },
    };

    const next = __testing.buildDiscordQaConfig(baseCfg, {
      guildId: "123456789012345678",
      channelId: "223456789012345678",
      driverBotId: "423456789012345678",
      sutAccountId: "sut",
      sutBotToken: "sut-token",
    });

    expect(next.plugins?.allow).toContain("discord");
    expect(next.plugins?.entries?.discord).toEqual({ enabled: true });
    expect(next.messages?.groupChat?.visibleReplies).toBe("automatic");
    expect(next.channels?.discord).toEqual({
      enabled: true,
      defaultAccount: "sut",
      accounts: {
        sut: {
          enabled: true,
          token: "sut-token",
          allowBots: "mentions",
          groupPolicy: "allowlist",
          guilds: {
            "123456789012345678": {
              requireMention: true,
              users: ["423456789012345678"],
              channels: {
                "223456789012345678": {
                  enabled: true,
                  requireMention: true,
                  users: ["423456789012345678"],
                },
              },
            },
          },
        },
      },
    });
  });

  it("injects Discord voice auto-join config for the voice smoke", () => {
    const next = __testing.buildDiscordQaConfig(
      {},
      {
        guildId: "123456789012345678",
        channelId: "223456789012345678",
        driverBotId: "423456789012345678",
        sutAccountId: "sut",
        sutBotToken: "sut-token",
      },
      {
        voiceAutoJoin: {
          guildId: "123456789012345678",
          channelId: "523456789012345678",
        },
      },
    );

    expect(next.channels?.discord?.voice).toEqual({
      enabled: true,
      autoJoin: [
        {
          guildId: "123456789012345678",
          channelId: "523456789012345678",
        },
      ],
    });
  });

  it("injects tool-only Discord status reaction config for the Mantis scenario", () => {
    const next = __testing.buildDiscordQaConfig(
      {},
      {
        guildId: "123456789012345678",
        channelId: "223456789012345678",
        driverBotId: "423456789012345678",
        sutAccountId: "sut",
        sutBotToken: "sut-token",
      },
      { statusReactionsToolOnly: true },
    );

    expect(next.messages).toMatchObject({
      ackReaction: "👀",
      ackReactionScope: "all",
      groupChat: { visibleReplies: "message_tool" },
      statusReactions: {
        enabled: true,
        timing: { debounceMs: 0 },
      },
    });
    expect(next.channels?.discord).toMatchObject({
      accounts: {
        sut: {
          allowBots: true,
          guilds: {
            "123456789012345678": {
              requireMention: false,
              channels: {
                "223456789012345678": {
                  requireMention: false,
                },
              },
            },
          },
        },
      },
    });
  });

  it("normalizes observed Discord messages", () => {
    expect(
      __testing.normalizeDiscordObservedMessage({
        id: "523456789012345678",
        channel_id: "223456789012345678",
        guild_id: "123456789012345678",
        content: "hello",
        timestamp: "2026-04-22T12:00:00.000Z",
        author: {
          id: "423456789012345678",
          username: "driver",
          bot: true,
        },
        referenced_message: { id: "323456789012345678" },
      }),
    ).toEqual({
      messageId: "523456789012345678",
      channelId: "223456789012345678",
      guildId: "123456789012345678",
      senderId: "423456789012345678",
      senderIsBot: true,
      senderUsername: "driver",
      text: "hello",
      replyToMessageId: "323456789012345678",
      timestamp: "2026-04-22T12:00:00.000Z",
    });
  });

  it("matches Discord scenario replies by SUT id and marker", () => {
    expect(
      __testing.matchesDiscordScenarioReply({
        channelId: "223456789012345678",
        sutBotId: "323456789012345678",
        matchText: "DISCORD_QA_ECHO_TOKEN",
        message: {
          messageId: "523456789012345678",
          channelId: "223456789012345678",
          senderId: "323456789012345678",
          senderIsBot: true,
          text: "reply DISCORD_QA_ECHO_TOKEN",
        },
      }),
    ).toBe(true);
    expect(
      __testing.matchesDiscordScenarioReply({
        channelId: "223456789012345678",
        sutBotId: "323456789012345678",
        matchText: "DISCORD_QA_ECHO_TOKEN",
        message: {
          messageId: "523456789012345679",
          channelId: "223456789012345678",
          senderId: "423456789012345678",
          senderIsBot: true,
          text: "reply DISCORD_QA_ECHO_TOKEN",
        },
      }),
    ).toBe(false);
  });

  it("includes the Discord live scenarios", () => {
    expect(__testing.findScenario().map((scenario) => scenario.id)).toEqual([
      "discord-canary",
      "discord-mention-gating",
      "discord-native-help-command-registration",
    ]);
    expect(
      __testing.findScenario(["discord-status-reactions-tool-only"]).map((scenario) => scenario.id),
    ).toEqual(["discord-status-reactions-tool-only"]);
    expect(
      __testing.findScenario(["discord-voice-autojoin"]).map((scenario) => scenario.id),
    ).toEqual(["discord-voice-autojoin"]);
    expect(
      __testing
        .findScenario(["discord-thread-reply-filepath-attachment"])
        .map((scenario) => scenario.id),
    ).toEqual(["discord-thread-reply-filepath-attachment"]);
  });

  it("collects the status reaction sequence across timeline snapshots", () => {
    expect(
      __testing.collectSeenReactionSequence(
        [
          {
            elapsedMs: 0,
            observedAt: "2026-05-03T12:00:00.000Z",
            reactions: [{ emoji: "👀", count: 1, me: true }],
          },
          {
            elapsedMs: 250,
            observedAt: "2026-05-03T12:00:00.250Z",
            reactions: [
              { emoji: "👀", count: 1, me: true },
              { emoji: "🤔", count: 1, me: true },
            ],
          },
          {
            elapsedMs: 500,
            observedAt: "2026-05-03T12:00:00.500Z",
            reactions: [{ emoji: "👍", count: 1, me: true }],
          },
        ],
        ["👀", "🤔", "👍"],
      ),
    ).toEqual(["👀", "🤔", "👍"]);
  });

  it("normalizes reaction snapshots from Discord messages", () => {
    expect(
      __testing.normalizeDiscordReactionSnapshot({
        startedAtMs: new Date("2026-05-03T12:00:00.000Z").getTime(),
        observedAt: new Date("2026-05-03T12:00:01.000Z"),
        message: {
          id: "523456789012345678",
          channel_id: "223456789012345678",
          reactions: [
            { count: 1, emoji: { name: "🤔" }, me: true },
            { count: 2, emoji: { name: "👀" }, me: false },
          ],
        },
      }),
    ).toEqual({
      elapsedMs: 1000,
      observedAt: "2026-05-03T12:00:01.000Z",
      reactions: [
        { emoji: "👀", count: 2, me: false },
        { emoji: "🤔", count: 1, me: true },
      ],
    });
  });

  it("renders a human-readable status reaction timeline artifact", () => {
    const html = __testing.renderDiscordStatusReactionHtml({
      scenarioTitle: "Discord status reactions",
      expectedSequence: ["👀", "🤔", "👍"],
      seenSequence: ["👀", "🤔"],
      snapshots: [
        {
          elapsedMs: 0,
          observedAt: "2026-05-03T12:00:00.000Z",
          reactions: [{ emoji: "👀", count: 1, me: true }],
        },
      ],
    });

    expect(html).toContain("Discord status reactions");
    expect(html).toContain("Expected: 👀 → 🤔 → 👍");
    expect(html).toContain("Seen: 👀 → 🤔");
  });

  it("renders a human-readable thread attachment artifact", () => {
    const html = __testing.renderDiscordThreadReplyAttachmentHtml({
      attachmentFilenames: [],
      expectedAttachmentFilename: "mantis-thread-report.md",
      messageContent: "Mantis thread attachment reply",
      scenarioTitle: "Discord thread reply preserves filePath attachment",
      status: "fail",
      threadName: "mantis-thread-filepath-1234",
    });

    expect(html).toContain("Attachment missing");
    expect(html).toContain("No attachments on the SUT thread reply");
    expect(html).toContain("mantis-thread-report.md");
  });

  it("builds Discord Web message URLs for logged-in Mantis capture", () => {
    expect(
      __testing.buildDiscordWebMessageUrl({
        guildId: "111111111111111111",
        messageId: "333333333333333333",
        threadId: "222222222222222222",
      }),
    ).toBe("https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333");
  });

  it("waits for the Discord account to become connected, not just running", async () => {
    vi.useFakeTimers();
    try {
      const gateway = {
        call: vi
          .fn()
          .mockResolvedValueOnce({
            channelAccounts: {
              discord: [
                { accountId: "sut", running: true, connected: false, restartPending: false },
              ],
            },
          })
          .mockResolvedValueOnce({
            channelAccounts: {
              discord: [
                { accountId: "sut", running: true, connected: true, restartPending: false },
              ],
            },
          }),
      } as unknown as Parameters<typeof __testing.waitForDiscordChannelRunning>[0];

      const readyPromise = __testing.waitForDiscordChannelRunning(gateway, "sut");
      await vi.advanceTimersByTimeAsync(600);

      await expect(readyPromise).resolves.toBeUndefined();
      expect(gateway.call).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the last Discord status when connection readiness times out", async () => {
    vi.useFakeTimers();
    try {
      const gateway = {
        call: vi.fn().mockResolvedValue({
          channelAccounts: {
            discord: [
              {
                accountId: "sut",
                running: true,
                connected: false,
                restartPending: false,
                lastError: null,
                lastDisconnect: { error: "runtime-not-ready" },
              },
            ],
          },
        }),
      } as unknown as Parameters<typeof __testing.waitForDiscordChannelRunning>[0];

      const readyPromise = __testing.waitForDiscordChannelRunning(gateway, "sut");
      const assertion = expect(readyPromise).rejects.toThrow(
        'discord account "sut" did not become connected (last status: running=true connected=false',
      );
      await vi.advanceTimersByTimeAsync(45_500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails when any requested Discord scenario id is unknown", () => {
    expect(() => __testing.findScenario(["discord-canary", "typo-scenario"])).toThrow(
      "unknown Discord QA scenario id(s): typo-scenario",
    );
  });

  it("tracks Discord live coverage against the shared transport contract", () => {
    expect(__testing.DISCORD_QA_STANDARD_SCENARIO_IDS).toEqual(["canary", "mention-gating"]);
    expect(
      findMissingLiveTransportStandardScenarios({
        coveredStandardScenarioIds: __testing.DISCORD_QA_STANDARD_SCENARIO_IDS,
        expectedStandardScenarioIds: LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
      }),
    ).toEqual(["allowlist-block", "top-level-reply-shape", "restart-resume"]);
  });

  it("lists Discord application commands through the REST API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | globalThis.Request, init?: RequestInit) => {
        expect(init?.headers).toBeInstanceOf(Headers);
        expect((init?.headers as Headers).get("authorization")).toBe("Bot token");
        return new Response(
          JSON.stringify([
            { id: "623456789012345678", name: "help" },
            { id: "623456789012345679", name: "commands" },
          ]),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }),
    );

    await expect(
      __testing.listApplicationCommands({
        token: "token",
        applicationId: "323456789012345678",
      }),
    ).resolves.toEqual([
      { id: "623456789012345678", name: "help" },
      { id: "623456789012345679", name: "commands" },
    ]);
  });

  it("discovers the first visible Discord voice channel for the voice smoke", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              { id: "123456789012345678", name: "general", position: 0, type: 0 },
              { id: "523456789012345678", name: "qa-voice", position: 1, type: 2 },
              { id: "623456789012345678", name: "stage", position: 2, type: 13 },
            ]),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          ),
      ),
    );

    await expect(
      __testing.resolveDiscordQaVoiceChannel({
        token: "token",
        guildId: "123456789012345678",
      }),
    ).resolves.toMatchObject({
      id: "523456789012345678",
      name: "qa-voice",
    });
  });

  it("normalizes missing current Discord voice state to null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "Unknown Voice State" }), {
            status: 404,
            headers: {
              "content-type": "application/json",
            },
          }),
      ),
    );

    await expect(
      __testing.getCurrentDiscordVoiceState({
        token: "token",
        guildId: "123456789012345678",
      }),
    ).resolves.toBeNull();
  });

  it("waits for required Discord application commands to be registered", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(
            new Response(JSON.stringify([{ id: "623456789012345679", name: "commands" }]), {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            }),
          )
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify([
                { id: "623456789012345679", name: "commands" },
                { id: "623456789012345678", name: "help" },
              ]),
              {
                status: 200,
                headers: {
                  "content-type": "application/json",
                },
              },
            ),
          ),
      );

      const registeredPromise = __testing.assertDiscordApplicationCommandsRegistered({
        token: "token",
        applicationId: "323456789012345678",
        expectedCommandNames: ["help"],
        timeoutMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(1_100);

      await expect(registeredPromise).resolves.toEqual({
        commandNames: ["commands", "help"],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the Discord API helper timeout for identity probes", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | globalThis.Request, init?: RequestInit) => {
        signal = init?.signal as AbortSignal | undefined;
        return new Response(JSON.stringify({ id: "423456789012345678" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }),
    );

    await expect(__testing.getCurrentDiscordUser("token")).resolves.toEqual({
      id: "423456789012345678",
    });
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    expect(signal).toBe(controller.signal);
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("retries Discord REST requests after a 429 rate limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: "You are being rate limited.", retry_after: 0 }), {
            status: 429,
            headers: {
              "content-type": "application/json",
            },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: "423456789012345678" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }),
        ),
    );

    await expect(__testing.getCurrentDiscordUser("token")).resolves.toEqual({
      id: "423456789012345678",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("redacts observed message content by default in artifacts", () => {
    expect(
      __testing.buildObservedMessagesArtifact({
        includeContent: false,
        redactMetadata: false,
        observedMessages: [
          {
            messageId: "523456789012345678",
            channelId: "223456789012345678",
            guildId: "123456789012345678",
            senderId: "323456789012345678",
            senderIsBot: true,
            senderUsername: "sut",
            text: "secret text",
            timestamp: "2026-04-22T12:00:00.000Z",
          },
        ],
      }),
    ).toEqual([
      {
        messageId: "523456789012345678",
        channelId: "223456789012345678",
        guildId: "123456789012345678",
        senderId: "323456789012345678",
        senderIsBot: true,
        senderUsername: "sut",
        replyToMessageId: undefined,
        timestamp: "2026-04-22T12:00:00.000Z",
      },
    ]);
  });
});
