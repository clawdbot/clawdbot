import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    createConnectionMock,
    joinVoiceChannelMock,
    createAudioPlayerMock,
    resolveConfiguredRealtimeVoiceProviderMock,
    assertSecretOwnerAvailableMock,
    isSecretOwnerAvailableMock,
    canonicalizeRealtimeVoiceProviderIdMock,
    realtimeModule,
    createManager,
  }) => {
    it("gates an unavailable explicit realtime secret owner before provider resolution", async () => {
      assertSecretOwnerAvailableMock.mockImplementationOnce(() => {
        throw new Error("SECRET_SURFACE_UNAVAILABLE: test owner is unavailable");
      });
      const session = new realtimeModule.DiscordRealtimeVoiceSession({
        accountId: "work",
        cfg: {},
        discordConfig: {
          voice: { enabled: true, mode: "agent-proxy", realtime: { provider: "openai" } },
        },
        entry: {
          guildId: "g1",
          channelId: "1001",
          voiceSessionKey: "discord:g1:1001",
          route: { agentId: "agent-1", sessionKey: "discord:g1:1001" },
          player: createAudioPlayerMock(),
        },
        mode: "agent-proxy",
        onTerminalError: vi.fn(),
        runAgentTurn: vi.fn(),
      } as never);

      await expect(session.connect()).rejects.toThrow("SECRET_SURFACE_UNAVAILABLE");

      expect(assertSecretOwnerAvailableMock).toHaveBeenCalledWith(
        "capability",
        "discord:voice:realtime:work:openai",
      );
      expect(resolveConfiguredRealtimeVoiceProviderMock).not.toHaveBeenCalled();
    });

    it("skips an unavailable auto provider before selecting a healthy fallback", async () => {
      isSecretOwnerAvailableMock.mockImplementation(
        (_ownerKind: string, ownerId: string) => !ownerId.endsWith(":openai"),
      );
      resolveConfiguredRealtimeVoiceProviderMock.mockImplementationOnce((params) => {
        expect(params?.configuredProviderId).toBeUndefined();
        expect(params?.isProviderAvailable?.({ id: "openai" })).toBe(false);
        expect(params?.isProviderAvailable?.({ id: "xai" })).toBe(true);
        return {
          provider: { id: "xai", capabilities: { supportsActivationNameGating: true } },
          providerConfig: { model: "grok-voice", voice: "ara" },
        };
      });
      const session = new realtimeModule.DiscordRealtimeVoiceSession({
        accountId: "work",
        cfg: {},
        discordConfig: { voice: { enabled: true, mode: "agent-proxy", realtime: {} } },
        entry: {
          guildId: "g1",
          channelId: "1001",
          voiceSessionKey: "discord:g1:1001",
          route: { agentId: "agent-1", sessionKey: "discord:g1:1001" },
          player: createAudioPlayerMock(),
        },
        mode: "agent-proxy",
        onTerminalError: vi.fn(),
        runAgentTurn: vi.fn(),
      } as never);

      await session.connect();

      expect(assertSecretOwnerAvailableMock).toHaveBeenCalledWith(
        "capability",
        "discord:voice:realtime:work:xai",
      );
    });

    it("preserves the typed owner error when every auto provider is unavailable", async () => {
      isSecretOwnerAvailableMock.mockReturnValue(false);
      assertSecretOwnerAvailableMock.mockImplementationOnce(() => {
        throw new Error(
          "Secret owner capability:discord:voice:realtime:work:openai is configured but unavailable (secret reference was not found).",
        );
      });
      resolveConfiguredRealtimeVoiceProviderMock.mockImplementationOnce((params) => {
        expect(params?.isProviderAvailable?.({ id: "openai" })).toBe(false);
        params?.assertProviderAvailable?.({ id: "openai" });
        throw new Error("expected availability assertion to throw");
      });
      const session = new realtimeModule.DiscordRealtimeVoiceSession({
        accountId: "work",
        cfg: {},
        discordConfig: { voice: { enabled: true, mode: "agent-proxy", realtime: {} } },
        entry: {
          guildId: "g1",
          channelId: "1001",
          voiceSessionKey: "discord:g1:1001",
          route: { agentId: "agent-1", sessionKey: "discord:g1:1001" },
          player: createAudioPlayerMock(),
        },
        mode: "agent-proxy",
        onTerminalError: vi.fn(),
        runAgentTurn: vi.fn(),
      } as never);

      await expect(session.connect()).rejects.toThrow(
        "Secret owner capability:discord:voice:realtime:work:openai is configured but unavailable",
      );
      expect(assertSecretOwnerAvailableMock).toHaveBeenCalledWith(
        "capability",
        "discord:voice:realtime:work:openai",
      );
    });

    it("gates the canonical secret owner for a configured realtime provider alias", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      canonicalizeRealtimeVoiceProviderIdMock.mockReturnValueOnce("xai");
      assertSecretOwnerAvailableMock.mockImplementation((_ownerKind: string, ownerId: string) => {
        if (ownerId === "discord:voice:realtime:work:xai") {
          throw new Error(
            "Secret owner capability:discord:voice:realtime:work:xai is configured but unavailable (secret reference was not found).",
          );
        }
      });
      const manager = createManager(
        {
          voice: {
            enabled: true,
            mode: "agent-proxy",
            realtime: { provider: "grok-voice" },
          },
        },
        undefined,
        {},
        "work",
      );

      const result = await manager.join({ guildId: "g1", channelId: "1001" });

      expect(result).toEqual({
        ok: false,
        message:
          "Failed to start Discord realtime voice: Secret owner capability:discord:voice:realtime:work:xai is configured but unavailable (secret reference was not found).",
        guildId: "g1",
        channelId: "1001",
      });
      expect(canonicalizeRealtimeVoiceProviderIdMock).toHaveBeenCalledWith("grok-voice", {});
      expect(assertSecretOwnerAvailableMock.mock.calls).toEqual([
        ["capability", "discord:voice:realtime:work:grok-voice"],
        ["capability", "discord:voice:realtime:work:xai"],
      ]);
      expect(resolveConfiguredRealtimeVoiceProviderMock).not.toHaveBeenCalled();
      expect(connection.destroy).toHaveBeenCalledOnce();
      expect(manager.status()).toEqual([]);
    });
  },
);
