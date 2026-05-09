import { describe, expect, it } from "vitest";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { createTtsDirectiveTextStreamCleaner, parseTtsDirectives } from "./directives.js";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechModelOverridePolicy,
} from "./provider-types.js";

function makeProvider(
  id: string,
  order: number,
  parse: (ctx: SpeechDirectiveTokenParseContext) => SpeechDirectiveTokenParseResult | undefined,
  options?: { aliases?: string[] },
): SpeechProviderPlugin {
  return {
    id,
    label: id,
    aliases: options?.aliases,
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

  it("does not fall through when the explicit provider does not handle the key", () => {
    const result = parseTtsDirectives("[[tts:provider=minimax style=0.4]]", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.overrides.provider).toBe("minimax");
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
    expect(result.overrides.providerOverrides?.minimax).toBeUndefined();
    expect(result.warnings).toContain('unsupported minimax directive key "style"');
  });

  it("keeps explicit-provider tokens scoped to the selected provider", () => {
    const result = parseTtsDirectives("[[tts:provider=minimax style=0.4 speed=1.2]]", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.overrides.provider).toBe("minimax");
    expect(result.overrides.providerOverrides?.minimax).toEqual({ speed: 1.2 });
    expect(result.overrides.providerOverrides?.elevenlabs).toBeUndefined();
    expect(result.warnings).toContain('unsupported minimax directive key "style"');
  });

  it("does not route explicit provider tokens to another provider with overlapping keys", () => {
    const openai = makeProvider("openai", 10, ({ key, value }) => {
      if (key === "model") {
        return { handled: true, overrides: { model: value } };
      }
      return undefined;
    });
    const elevenlabsModel = makeProvider("elevenlabs", 20, ({ key, value }) => {
      if (key === "model") {
        return { handled: true, overrides: { modelId: value } };
      }
      return undefined;
    });

    const result = parseTtsDirectives("[[tts:provider=elevenlabs model=eleven_v3]]", fullPolicy, {
      providers: [openai, elevenlabsModel],
    });

    expect(result.overrides.provider).toBe("elevenlabs");
    expect(result.overrides.providerOverrides?.elevenlabs).toEqual({ modelId: "eleven_v3" });
    expect(result.overrides.providerOverrides?.openai).toBeUndefined();
    expect(result.warnings).toStrictEqual([]);
  });

  it("warns instead of routing prefixed tokens to another provider when provider is explicit", () => {
    const result = parseTtsDirectives(
      "[[tts:provider=elevenlabs openai_model=gpt-4o-mini-tts]]",
      fullPolicy,
      { providers: [elevenlabs, minimax] },
    );

    expect(result.overrides.provider).toBe("elevenlabs");
    expect(result.overrides.providerOverrides).toBeUndefined();
    expect(result.warnings).toContain('unsupported elevenlabs directive key "openai_model"');
  });

  it("passes the selected provider id to the chosen provider parser", () => {
    let selectedProvider: string | undefined;
    const selected = makeProvider("selected", 10, (ctx) => {
      selectedProvider = ctx.selectedProvider;
      return { handled: true, overrides: { voice: ctx.value } };
    });

    const result = parseTtsDirectives("[[tts:provider=selected voice=test]]", fullPolicy, {
      providers: [selected],
    });

    expect(result.overrides.providerOverrides?.selected).toEqual({ voice: "test" });
    expect(selectedProvider).toBe("selected");
  });

  it("resolves explicit provider aliases without rewriting the requested provider value", () => {
    const microsoft = makeProvider(
      "microsoft",
      10,
      ({ key, value }) =>
        key === "voice" ? { handled: true, overrides: { voice: value } } : undefined,
      { aliases: ["edge"] },
    );

    const result = parseTtsDirectives(
      "[[tts:provider=edge voice=en-US-MichelleNeural]]",
      fullPolicy,
      {
        providers: [microsoft],
      },
    );

    expect(result.overrides.provider).toBe("edge");
    expect(result.overrides.providerOverrides?.microsoft).toEqual({
      voice: "en-US-MichelleNeural",
    });
    expect(result.warnings).toStrictEqual([]);
  });

  it("warns once and drops non-provider tokens when the explicit provider is unknown", () => {
    const result = parseTtsDirectives("[[tts:provider=missing speed=1.2 style=0.4]]", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.overrides.provider).toBe("missing");
    expect(result.overrides.providerOverrides).toBeUndefined();
    expect(result.warnings).toEqual(['unknown provider "missing"']);
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

  it("accepts bare tts tags as a tagged-mode trigger", () => {
    const result = parseTtsDirectives("[[tts]] read this aloud", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.hasDirective).toBe(true);
    expect(result.cleanedText).toBe(" read this aloud");
    expect(result.ttsText).toBeUndefined();
  });

  it("accepts plain tts blocks as speak-and-show text", () => {
    const result = parseTtsDirectives("[[tts]]hello world[[/tts]]", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.hasDirective).toBe(true);
    expect(result.cleanedText).toBe("hello world");
    expect(result.ttsText).toBe("hello world");
  });

  it("strips orphan closing tts tags", () => {
    const result = parseTtsDirectives("spoken content[[/tts:text]]", fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result.hasDirective).toBe(true);
    expect(result.cleanedText).toBe("spoken content");
  });

  it("does not parse tts examples inside markdown code", () => {
    const input = [
      "Use `[[tts:text]]` for hidden speech.",
      "",
      "```",
      "[[tts:provider=elevenlabs voice=alloy]]",
      "```",
      "",
      "Then continue normally.",
    ].join("\n");
    const result = parseTtsDirectives(input, fullPolicy, {
      providers: [elevenlabs, minimax],
    });

    expect(result).toEqual({
      cleanedText: input,
      overrides: {},
      warnings: [],
      hasDirective: false,
    });
  });
});

describe("createTtsDirectiveTextStreamCleaner", () => {
  it("strips directive tags split across streamed chunks", () => {
    const cleaner = createTtsDirectiveTextStreamCleaner();

    expect(cleaner.push("Hello [[tts:voice=al")).toBe("Hello ");
    expect(cleaner.push("loy]]world[[/tt")).toBe("world");
    expect(cleaner.push("s]]")).toBe("");
    expect(cleaner.flush()).toBe("");
  });

  it("suppresses hidden tts text blocks while preserving normal text", () => {
    const cleaner = createTtsDirectiveTextStreamCleaner();

    expect(cleaner.push("Shown [[tts:text]]hid")).toBe("Shown ");
    expect(cleaner.push("den[[/tts:text]] visible")).toBe(" visible");
    expect(cleaner.flush()).toBe("");
  });

  it("keeps plain tts block contents visible", () => {
    const cleaner = createTtsDirectiveTextStreamCleaner();

    expect(cleaner.push("[[tts]]read")).toBe("read");
    expect(cleaner.push(" this[[/tts]] now")).toBe(" this now");
  });

  it("preserves non-tts bracket markup and flushes incomplete literals", () => {
    const cleaner = createTtsDirectiveTextStreamCleaner();

    expect(cleaner.push("See [[note")).toBe("See ");
    expect(cleaner.flush()).toBe("[[note");
  });
});
