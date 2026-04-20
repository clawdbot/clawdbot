import { describe, expect, it } from "vitest";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { parseTtsDirectives } from "./directives.js";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechModelOverridePolicy,
} from "./provider-types.js";

function makeProvider(
  id: string,
  order: number,
  parse: (ctx: SpeechDirectiveTokenParseContext) => SpeechDirectiveTokenParseResult | undefined,
): SpeechProviderPlugin {
  return {
    id,
    label: id,
    autoSelectOrder: order,
    parseDirectiveToken: parse,
    isConfigured: () => true,
    synthesize: async () => ({
      audioBuffer: Buffer.alloc(0),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    }),
  } as SpeechProviderPlugin;
}

const elevenlabs = makeProvider("elevenlabs", 10, ({ key, value }) => {
  if (key === "speed") {
    return { handled: true, overrides: { speed: Number(value) } };
  }
  if (key === "style") {
    return { handled: true, overrides: { style: Number(value) } };
  }
  return undefined;
});

const minimax = makeProvider("minimax", 20, ({ key, value }) => {
  if (key === "speed") {
    return { handled: true, overrides: { speed: Number(value) } };
  }
  return undefined;
});

const fullPolicy: SpeechModelOverridePolicy = {
  enabled: true,
  allowText: true,
  allowProvider: true,
  allowVoice: true,
  allowModelId: true,
  allowVoiceSettings: true,
  allowNormalization: true,
  allowSeed: true,
};

describe("parseTtsDirectives provider-aware routing", () => {
  it("does not resolve providers when text has no directives", () => {
    const failProvider = {
      get id() {
        throw new Error("provider should not be read without directives");
      },
      get autoSelectOrder() {
        throw new Error("provider order should not be read without directives");
      },
    } as unknown as SpeechProviderPlugin;

    const result = parseTtsDirectives("hello without TTS markup", fullPolicy, {
      providers: [failProvider, failProvider],
    });

    expect(result).toEqual({
      cleanedText: "hello without TTS markup",
      overrides: {},
      warnings: [],
      hasDirective: false,
    });
  });

  it("routes generic speed to the explicitly declared provider", () => {
    const result = parseTtsDirectives(
      "hello [[tts:provider=minimax speed=1.2]] world",
      fullPolicy,
      {
        providers: [elevenlabs, minimax],
      },
    );

    expect(result.overrides.provider).toBe("minimax");
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.2 });
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
  });

  it("routes correctly when provider appears after the generic token", () => {
    const result = parseTtsDirectives("[[tts:speed=1.2 provider=minimax]] hi", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.overrides.provider).toBe("minimax");
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.2 });
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
  });

  it("routes to the preferred provider when no provider token is declared", () => {
    const result = parseTtsDirectives("[[tts:speed=1.5]]", fullPolicy, {
      providers: [elevenlabs, minimax],
      preferredProviderId: "minimax",
    });

    expect(result.overrides.provider).toBeUndefined();
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.5 });
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
  });

  it("falls back to autoSelectOrder when no provider hint is available", () => {
    const result = parseTtsDirectives("[[tts:speed=1.5]]", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.overrides.provider).toBeUndefined();
    expect(result.overrides.providerOverrides?.elevenlabs).toEqual({ speed: 1.5 });
    expect(result.overrides.providerOverrides?.minimax).toBeUndefined();
  });

  it("falls through when the preferred provider does not handle the key", () => {
    const result = parseTtsDirectives("[[tts:provider=minimax style=0.4]]", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.overrides.provider).toBe("minimax");
    expect(result.overrides.providerOverrides?.elevenlabs).toEqual({ style: 0.4 });
    expect(result.overrides.providerOverrides?.minimax).toBeUndefined();
  });

  it("routes mixed tokens independently in the same directive", () => {
    const result = parseTtsDirectives("[[tts:provider=minimax style=0.4 speed=1.2]]", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.overrides.provider).toBe("minimax");
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.2 });
    expect(result.overrides.providerOverrides?.elevenlabs).toEqual({ style: 0.4 });
  });

  it("keeps last-wins provider semantics", () => {
    const result = parseTtsDirectives(
      "[[tts:provider=elevenlabs provider=minimax speed=1.1]]",
      fullPolicy,
      { providers: [elevenlabs, minimax] },
    );

    expect(result.overrides.provider).toBe("minimax");
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.1 });
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
  });

  it("ignores provider tokens when provider overrides are disabled", () => {
    const policy: SpeechModelOverridePolicy = { ...fullPolicy, allowProvider: false };
    const result = parseTtsDirectives("[[tts:provider=elevenlabs speed=1.2]]", policy, {
      providers: [elevenlabs, minimax],
      preferredProviderId: "minimax",
    });

    expect(result.overrides.provider).toBeUndefined();
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.2 });
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
  });
});
