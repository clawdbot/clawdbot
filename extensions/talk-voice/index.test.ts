import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "./api.js";
import register from "./index.js";

function createHarness(config: Record<string, unknown>) {
  let command: OpenClawPluginCommandDefinition | undefined;
  const runtime = {
    config: {
      loadConfig: vi.fn(() => config),
      writeConfigFile: vi.fn().mockResolvedValue(undefined),
    },
    tts: {
      listVoices: vi.fn(),
    },
  } as unknown as PluginRuntime;
  const api = {
    runtime,
    registerCommand: vi.fn((definition: OpenClawPluginCommandDefinition) => {
      command = definition;
    }),
  };
  register.register(api as never);
  if (!command) {
    throw new Error("talk-voice command not registered");
  }
  return { command, runtime };
}

function createCommandContext(
  args: string,
  channel: string = "discord",
  gatewayClientScopes?: string[],
) {
  return {
    args,
    channel,
    channelId: channel,
    isAuthorizedSender: true,
    gatewayClientScopes,
    commandBody: args ? `/voice ${args}` : "/voice",
    config: {},
    requestConversationBinding: vi.fn(),
    detachConversationBinding: vi.fn(),
    getCurrentConversationBinding: vi.fn(),
  };
}

describe("talk-voice plugin", () => {
  function createElevenlabsVoiceSetHarness(channel = "webchat", scopes?: string[]) {
    const { command, runtime } = createHarness({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: "sk-eleven",
          },
        },
      },
    });
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([{ id: "voice-a", name: "Claudia" }]);
    return {
      runtime,
      run: async () => await command.handler(createCommandContext("set Claudia", channel, scopes)),
    };
  }

  it("reports active provider status", async () => {
    const { command } = createHarness({
      talk: {
        provider: "microsoft",
        providers: {
          microsoft: {
            voiceId: "en-US-AvaNeural",
            apiKey: "secret-token",
          },
        },
      },
    });

    const result = await command.handler(createCommandContext(""));

    expect(result).toEqual({
      text:
        "Talk voice status:\n" +
        "- provider: microsoft\n" +
        "- talk.providers.microsoft.voiceId: en-US-AvaNeural\n" +
        "- microsoft.apiKey: secret…",
    });
  });

  it("lists voices from the active provider", async () => {
    const { command, runtime } = createHarness({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: "sk-eleven",
            baseUrl: "https://voices.example.test",
          },
        },
      },
    });
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([
      { id: "voice-a", name: "Claudia", category: "general" },
      { id: "voice-b", name: "Bert" },
    ]);

    const result = await command.handler(createCommandContext("list 1"));

    expect(runtime.tts.listVoices).toHaveBeenCalledWith({
      provider: "elevenlabs",
      cfg: {
        talk: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: {
              apiKey: "sk-eleven",
              baseUrl: "https://voices.example.test",
            },
          },
        },
      },
      apiKey: "sk-eleven",
      baseUrl: "https://voices.example.test",
    });
    expect(result).toEqual({
      text:
        "ElevenLabs voices: 2\n\n" +
        "- Claudia · general\n" +
        "  id: voice-a\n\n" +
        "(showing first 1)",
    });
  });

  it("surfaces richer provider voice metadata when available", async () => {
    const { command, runtime } = createHarness({
      talk: {
        provider: "microsoft",
        providers: {
          microsoft: {},
        },
      },
    });
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([
      {
        id: "en-US-AvaNeural",
        name: "Ava",
        category: "General",
        locale: "en-US",
        gender: "Female",
        personalities: ["Friendly", "Positive"],
        description: "Friendly, Positive",
      },
    ]);

    const result = await command.handler(createCommandContext("list"));

    expect(result).toEqual({
      text:
        "Microsoft voices: 1\n\n" +
        "- Ava · General\n" +
        "  id: en-US-AvaNeural\n" +
        "  meta: en-US · Female · Friendly, Positive\n" +
        "  note: Friendly, Positive",
    });
  });

  it("writes canonical talk provider config and legacy elevenlabs voice id", async () => {
    const { command, runtime } = createHarness({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: "sk-eleven",
          },
        },
      },
    });
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([{ id: "voice-a", name: "Claudia" }]);

    const result = await command.handler(
      createCommandContext("set Claudia", "webchat", ["operator.admin"]),
    );

    expect(runtime.config.writeConfigFile).toHaveBeenCalledWith({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: "sk-eleven",
            voiceId: "voice-a",
          },
        },
        voiceId: "voice-a",
      },
    });
    expect(result).toEqual({
      text: "✅ ElevenLabs Talk voice set to Claudia\nvoice-a",
    });
  });

  it("writes provider voice id without legacy top-level field for microsoft", async () => {
    const { command, runtime } = createHarness({
      talk: {
        provider: "microsoft",
        providers: {
          microsoft: {},
        },
      },
    });
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([{ id: "en-US-AvaNeural", name: "Ava" }]);

    await command.handler(createCommandContext("set Ava", "webchat", ["operator.admin"]));

    expect(runtime.config.writeConfigFile).toHaveBeenCalledWith({
      talk: {
        provider: "microsoft",
        providers: {
          microsoft: {
            voiceId: "en-US-AvaNeural",
          },
        },
      },
    });
  });

  it("rejects /voice set from gateway client with only operator.write scope", async () => {
    const { runtime, run } = createElevenlabsVoiceSetHarness("webchat", ["operator.write"]);
    const result = await run();

    expect(result.text).toContain("requires operator.admin");
    expect(runtime.config.writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects /voice set from non-webchat gateway callers missing operator.admin", async () => {
    const { runtime, run } = createElevenlabsVoiceSetHarness("telegram", ["operator.write"]);
    const result = await run();

    expect(result.text).toContain("requires operator.admin");
    expect(runtime.config.writeConfigFile).not.toHaveBeenCalled();
  });

  it("allows /voice set from gateway client with operator.admin scope", async () => {
    const { runtime, run } = createElevenlabsVoiceSetHarness("webchat", ["operator.admin"]);
    const result = await run();

    expect(runtime.config.writeConfigFile).toHaveBeenCalled();
    expect(result.text).toContain("voice-a");
  });

  it("rejects /voice set from webchat channel with no scopes (TUI/internal)", async () => {
    const { runtime, run } = createElevenlabsVoiceSetHarness();
    const result = await run();

    expect(result.text).toContain("requires operator.admin");
    expect(runtime.config.writeConfigFile).not.toHaveBeenCalled();
  });

  it("allows /voice set from non-gateway channels without operator.admin", async () => {
    const { runtime, run } = createElevenlabsVoiceSetHarness("telegram");
    const result = await run();

    expect(runtime.config.writeConfigFile).toHaveBeenCalled();
    expect(result.text).toContain("voice-a");
  });

  it("allows /voice set when operator.admin is present on a non-webchat channel", async () => {
    const { runtime, run } = createElevenlabsVoiceSetHarness("telegram", ["operator.admin"]);
    const result = await run();

    expect(runtime.config.writeConfigFile).toHaveBeenCalled();
    expect(result.text).toContain("voice-a");
  });

  it("returns provider lookup errors cleanly", async () => {
    const { command, runtime } = createHarness({
      talk: {
        provider: "microsoft",
        providers: {
          microsoft: {},
        },
      },
    });
    vi.mocked(runtime.tts.listVoices).mockRejectedValue(
      new Error("speech provider microsoft does not support voice listing"),
    );

    const result = await command.handler(createCommandContext("list"));

    expect(result).toEqual({
      text: "Microsoft voice list failed: speech provider microsoft does not support voice listing",
    });
  });
});
