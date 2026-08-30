// Voice Call tests cover config plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VoiceCallConfigSchema,
  resolveTwilioAuthToken,
  resolveVoiceCallEffectiveConfig,
  resolveVoiceCallNumberRouteKeyForCall,
  resolveVoiceCallSessionKey,
  resolveVoiceCallStreamExposurePaths,
  validateProviderConfig,
  normalizeVoiceCallConfig,
  resolveVoiceCallConfig,
  type VoiceCallConfig,
} from "./config.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

function createBaseConfig(provider: "telnyx" | "twilio" | "plivo" | "mock"): VoiceCallConfig {
  return createVoiceCallBaseConfig({ provider });
}

function resolveVoiceCallAgentSessionKey(params: {
  config: VoiceCallConfig;
  sessionKey: string;
  coreSession?: Parameters<typeof resolveVoiceCallSessionKey>[0]["coreSession"];
}): string {
  return resolveVoiceCallSessionKey({
    config: params.config,
    callId: "test-call",
    explicitSessionKey: params.sessionKey,
    coreSession: params.coreSession,
  });
}

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

function requireElevenLabsTtsConfig(config: Pick<VoiceCallConfig, "tts">) {
  const tts = config.tts;
  const elevenlabs = tts?.providers?.elevenlabs;
  if (!elevenlabs || typeof elevenlabs !== "object") {
    throw new Error("voice-call config did not preserve nested elevenlabs TTS config");
  }
  return { tts, elevenlabs };
}

describe("validateProviderConfig", () => {
  const clearProviderEnv = () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", undefined);
    vi.stubEnv("TWILIO_AUTH_TOKEN", undefined);
    vi.stubEnv("TWILIO_FROM_NUMBER", undefined);
    vi.stubEnv("TELNYX_API_KEY", undefined);
    vi.stubEnv("TELNYX_CONNECTION_ID", undefined);
    vi.stubEnv("TELNYX_PUBLIC_KEY", undefined);
    vi.stubEnv("PLIVO_AUTH_ID", undefined);
    vi.stubEnv("PLIVO_AUTH_TOKEN", undefined);
    vi.stubEnv("NGROK_AUTHTOKEN", undefined);
    vi.stubEnv("NGROK_DOMAIN", undefined);
  };

  beforeEach(() => {
    clearProviderEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("provider credential sources", () => {
    it("passes validation when credentials come from config or environment", () => {
      for (const provider of ["twilio", "telnyx", "plivo"] as const) {
        clearProviderEnv();
        const fromConfig = createBaseConfig(provider);
        if (provider === "twilio") {
          fromConfig.twilio = { accountSid: "AC123", authToken: "secret" };
        } else if (provider === "telnyx") {
          fromConfig.telnyx = {
            apiKey: "KEY123",
            connectionId: "CONN456",
            publicKey: "public-key",
          };
        } else {
          fromConfig.plivo = { authId: "MA123", authToken: "secret" };
        }
        expect(validateProviderConfig(fromConfig)).toEqual({ valid: true, errors: [] });

        clearProviderEnv();
        if (provider === "twilio") {
          process.env.TWILIO_ACCOUNT_SID = "AC123";
          process.env.TWILIO_AUTH_TOKEN = "secret";
          process.env.TWILIO_FROM_NUMBER = "+15550001234";
        } else if (provider === "telnyx") {
          process.env.TELNYX_API_KEY = "KEY123";
          process.env.TELNYX_CONNECTION_ID = "CONN456";
          process.env.TELNYX_PUBLIC_KEY = "public-key";
        } else {
          process.env.PLIVO_AUTH_ID = "MA123";
          process.env.PLIVO_AUTH_TOKEN = "secret";
        }
        const fromEnv = resolveVoiceCallConfig(createBaseConfig(provider));
        expect(validateProviderConfig(fromEnv)).toEqual({ valid: true, errors: [] });
      }
    });

    it("ignores blank provider and tunnel environment values", () => {
      for (const provider of ["twilio", "telnyx", "plivo"] as const) {
        clearProviderEnv();
        process.env.TWILIO_ACCOUNT_SID = "   ";
        process.env.TWILIO_AUTH_TOKEN = "   ";
        process.env.TWILIO_FROM_NUMBER = "   ";
        process.env.TELNYX_API_KEY = "   ";
        process.env.TELNYX_CONNECTION_ID = "   ";
        process.env.TELNYX_PUBLIC_KEY = "   ";
        process.env.PLIVO_AUTH_ID = "   ";
        process.env.PLIVO_AUTH_TOKEN = "   ";
        process.env.NGROK_AUTHTOKEN = "   ";
        process.env.NGROK_DOMAIN = "   ";

        const config = resolveVoiceCallConfig({
          ...createBaseConfig(provider),
          fromNumber: undefined,
          tunnel: { provider: "ngrok" },
        });
        const result = validateProviderConfig(config);

        expect(result.valid).toBe(false);
        expect(config.tunnel.ngrokAuthToken).toBeUndefined();
        expect(config.tunnel.ngrokDomain).toBeUndefined();
        if (provider === "twilio") {
          expect(config.fromNumber).toBeUndefined();
          expect(config.twilio?.accountSid).toBeUndefined();
          expect(config.twilio?.authToken).toBeUndefined();
          expect(result.errors).toContain(
            "plugins.entries.voice-call.config.twilio.accountSid is required (or set TWILIO_ACCOUNT_SID env)",
          );
          expect(result.errors).toContain(
            "plugins.entries.voice-call.config.twilio.authToken is required (or set TWILIO_AUTH_TOKEN env)",
          );
          expect(result.errors).toContain(
            "plugins.entries.voice-call.config.fromNumber is required (or set TWILIO_FROM_NUMBER env)",
          );
        } else if (provider === "telnyx") {
          expect(config.telnyx?.apiKey).toBeUndefined();
          expect(config.telnyx?.connectionId).toBeUndefined();
          expect(config.telnyx?.publicKey).toBeUndefined();
          expect(result.errors).toContain(
            "plugins.entries.voice-call.config.telnyx.apiKey is required (or set TELNYX_API_KEY env)",
          );
          expect(result.errors).toContain(
            "plugins.entries.voice-call.config.telnyx.connectionId is required (or set TELNYX_CONNECTION_ID env)",
          );
        } else {
          expect(config.plivo?.authId).toBeUndefined();
          expect(config.plivo?.authToken).toBeUndefined();
          expect(result.errors).toContain(
            "plugins.entries.voice-call.config.plivo.authId is required (or set PLIVO_AUTH_ID env)",
          );
          expect(result.errors).toContain(
            "plugins.entries.voice-call.config.plivo.authToken is required (or set PLIVO_AUTH_TOKEN env)",
          );
        }
      }
    });
  });

  describe("twilio provider", () => {
    it("accepts supported Twilio Regions and rejects unknown ones", () => {
      const baseConfig = {
        enabled: true,
        provider: "twilio",
        fromNumber: "+15550001234",
        twilio: {
          accountSid: "AC123",
          authToken: "secret",
        },
      } as const;

      const regional = VoiceCallConfigSchema.parse({
        ...baseConfig,
        twilio: { ...baseConfig.twilio, region: "ie1" },
      });
      expect(regional.twilio?.region).toBe("ie1");
      expect(
        VoiceCallConfigSchema.safeParse({
          ...baseConfig,
          twilio: { ...baseConfig.twilio, region: "de1" },
        }).success,
      ).toBe(false);
    });

    it("accepts SecretRef-backed auth tokens before runtime resolution", () => {
      const config = VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "twilio",
        fromNumber: "+15550001234",
        twilio: {
          accountSid: "AC123",
          authToken: envRef("TWILIO_AUTH_TOKEN"),
        },
      });

      expect(config.twilio?.authToken).toEqual(envRef("TWILIO_AUTH_TOKEN"));
      expect(validateProviderConfig(config)).toEqual({ valid: true, errors: [] });
      expect(() => resolveTwilioAuthToken(config)).toThrow(
        'plugins.entries.voice-call.config.twilio.authToken: unresolved SecretRef "env:default:TWILIO_AUTH_TOKEN"',
      );
    });

    it("passes validation with mixed config and env vars", () => {
      process.env.TWILIO_AUTH_TOKEN = "secret";
      let config = createBaseConfig("twilio");
      config.twilio = { accountSid: "AC123" };
      config = resolveVoiceCallConfig(config);

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toStrictEqual([]);
    });

    it("resolves the Twilio from number from environment", () => {
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "secret";
      process.env.TWILIO_FROM_NUMBER = "+15550001234";

      const config = resolveVoiceCallConfig({
        ...createBaseConfig("twilio"),
        fromNumber: undefined,
      });

      expect(config.fromNumber).toBe("+15550001234");
      expect(validateProviderConfig(config)).toEqual({ valid: true, errors: [] });
    });

    it("fails validation when required twilio credentials are missing", () => {
      process.env.TWILIO_AUTH_TOKEN = "secret";
      const missingSid = validateProviderConfig(resolveVoiceCallConfig(createBaseConfig("twilio")));
      expect(missingSid.valid).toBe(false);
      expect(missingSid.errors).toContain(
        "plugins.entries.voice-call.config.twilio.accountSid is required (or set TWILIO_ACCOUNT_SID env)",
      );

      delete process.env.TWILIO_AUTH_TOKEN;
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      const missingToken = validateProviderConfig(
        resolveVoiceCallConfig(createBaseConfig("twilio")),
      );
      expect(missingToken.valid).toBe(false);
      expect(missingToken.errors).toContain(
        "plugins.entries.voice-call.config.twilio.authToken is required (or set TWILIO_AUTH_TOKEN env)",
      );
    });
  });

  describe("telnyx provider", () => {
    it("fails validation when apiKey is missing everywhere", () => {
      process.env.TELNYX_CONNECTION_ID = "CONN456";
      let config = createBaseConfig("telnyx");
      config = resolveVoiceCallConfig(config);

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "plugins.entries.voice-call.config.telnyx.apiKey is required (or set TELNYX_API_KEY env)",
      );
    });

    it("requires a public key unless signature verification is skipped", () => {
      const missingPublicKey = createBaseConfig("telnyx");
      missingPublicKey.inboundPolicy = "allowlist";
      missingPublicKey.telnyx = { apiKey: "KEY123", connectionId: "CONN456" };
      const missingPublicKeyResult = validateProviderConfig(missingPublicKey);
      expect(missingPublicKeyResult.valid).toBe(false);
      expect(missingPublicKeyResult.errors).toContain(
        "plugins.entries.voice-call.config.telnyx.publicKey is required (or set TELNYX_PUBLIC_KEY env)",
      );

      const withPublicKey = createBaseConfig("telnyx");
      withPublicKey.inboundPolicy = "allowlist";
      withPublicKey.telnyx = {
        apiKey: "KEY123",
        connectionId: "CONN456",
        publicKey: "public-key",
      };
      expect(validateProviderConfig(withPublicKey)).toEqual({ valid: true, errors: [] });

      const skippedVerification = createBaseConfig("telnyx");
      skippedVerification.skipSignatureVerification = true;
      skippedVerification.telnyx = { apiKey: "KEY123", connectionId: "CONN456" };
      expect(validateProviderConfig(skippedVerification)).toEqual({
        valid: true,
        errors: [],
      });
    });
  });

  describe("plivo provider", () => {
    it("fails validation when authId is missing everywhere", () => {
      process.env.PLIVO_AUTH_TOKEN = "secret";
      let config = createBaseConfig("plivo");
      config = resolveVoiceCallConfig(config);

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "plugins.entries.voice-call.config.plivo.authId is required (or set PLIVO_AUTH_ID env)",
      );
    });
  });

  describe("disabled config", () => {
    it("skips validation when enabled is false", () => {
      const config = createBaseConfig("twilio");
      config.enabled = false;

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toStrictEqual([]);
    });
  });

  describe("realtime config", () => {
    it("rejects disabled inbound policy for realtime mode", () => {
      const config = createBaseConfig("twilio");
      config.realtime.enabled = true;
      config.inboundPolicy = "disabled";

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'plugins.entries.voice-call.config.inboundPolicy must not be "disabled" when realtime.enabled is true',
      );
    });

    it("rejects enabling realtime and streaming together", () => {
      const config = createBaseConfig("twilio");
      config.realtime.enabled = true;
      config.streaming.enabled = true;
      config.inboundPolicy = "allowlist";

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "plugins.entries.voice-call.config.realtime.enabled and plugins.entries.voice-call.config.streaming.enabled cannot both be true",
      );
    });

    it("accepts realtime.enabled with provider=telnyx", () => {
      const config = createBaseConfig("telnyx");
      config.realtime.enabled = true;
      config.inboundPolicy = "allowlist";

      const result = validateProviderConfig(config);

      expect(result.errors).not.toContain(
        'plugins.entries.voice-call.config.provider must be "twilio", "telnyx", or "mock" when realtime.enabled is true',
      );
    });

    it("accepts realtime.enabled with provider=mock", () => {
      const config = createBaseConfig("mock");
      config.realtime.enabled = true;
      config.inboundPolicy = "allowlist";

      const result = validateProviderConfig(config);

      expect(result).toEqual({ valid: true, errors: [] });
    });

    it("rejects realtime.enabled with providers that do not support it yet", () => {
      const config = createBaseConfig("plivo");
      config.realtime.enabled = true;
      config.inboundPolicy = "allowlist";

      const result = validateProviderConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'plugins.entries.voice-call.config.provider must be "twilio", "telnyx", or "mock" when realtime.enabled is true',
      );
    });
  });

  describe("streaming config", () => {
    it.each(["telnyx", "plivo", "mock"] as const)(
      "rejects streaming.enabled with provider=%s",
      (provider) => {
        const config = createBaseConfig(provider);
        config.streaming.enabled = true;

        const result = validateProviderConfig(config);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
          'plugins.entries.voice-call.config.provider must be "twilio" when streaming.enabled is true',
        );
      },
    );

    it("accepts streaming.enabled with provider=twilio", () => {
      const config = createBaseConfig("twilio");
      config.streaming.enabled = true;
      config.twilio = {
        accountSid: "AC123",
        authToken: { source: "env", provider: "default", id: "TWILIO_AUTH_TOKEN" },
      };

      expect(validateProviderConfig(config)).toEqual({ valid: true, errors: [] });
    });
  });
});

describe("Tailscale external HTTPS port", () => {
  it.each([
    {
      name: "Serve on an arbitrary valid port",
      input: { tailscale: { mode: "serve", port: 4545 } },
    },
    { name: "legacy Funnel on 8443", input: { tailscale: { mode: "funnel", port: 8443 } } },
    {
      name: "unified Funnel on 10000",
      input: {
        tailscale: { port: 10000 },
        tunnel: { provider: "tailscale-funnel" },
      },
    },
  ])("accepts $name", ({ input }) => {
    expect(VoiceCallConfigSchema.safeParse(input).success).toBe(true);
  });

  it.each([0, 1.5, 65_536])("rejects invalid HTTPS port %s", (port) => {
    expect(VoiceCallConfigSchema.safeParse({ tailscale: { port } }).success).toBe(false);
  });

  it.each([
    { name: "legacy mode", input: { tailscale: { mode: "funnel", port: 4545 } } },
    {
      name: "unified provider",
      input: {
        tailscale: { port: 4545 },
        tunnel: { provider: "tailscale-funnel" },
      },
    },
  ])("rejects unsupported Funnel port for $name", ({ input }) => {
    const result = VoiceCallConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["tailscale", "port"],
          message: "Tailscale Funnel HTTPS port must be one of 443, 8443, 10000",
        }),
      );
    }
  });
});

describe("resolveVoiceCallConfig session routing", () => {
  it("enables the pre-answer stale call reaper by default", () => {
    const config = resolveVoiceCallConfig({ enabled: true, provider: "mock" });

    expect(config.staleCallReaperSeconds).toBe(120);
  });

  it("keeps voice sessions scoped by phone by default", () => {
    const config = resolveVoiceCallConfig({ enabled: true, provider: "mock" });

    expect(config.sessionScope).toBe("per-phone");
    expect(
      resolveVoiceCallSessionKey({
        config,
        callId: "call-123",
        phone: "+1 (555) 000-1111",
      }),
    ).toBe("agent:main:voice:15550001111");
  });

  it("scopes generated voice session keys by configured agent", () => {
    const config = resolveVoiceCallConfig({
      enabled: true,
      provider: "mock",
      agentId: "Voice",
    });

    expect(
      resolveVoiceCallSessionKey({
        config,
        callId: "CALL-123",
        phone: "+1 (555) 000-1111",
      }),
    ).toBe("agent:voice:voice:15550001111");
  });

  it("can scope voice sessions to each call", () => {
    const config = resolveVoiceCallConfig({
      enabled: true,
      provider: "mock",
      sessionScope: "per-call",
    });

    expect(config.sessionScope).toBe("per-call");
    expect(
      resolveVoiceCallSessionKey({
        config,
        callId: "call-123",
        phone: "+1 (555) 000-1111",
      }),
    ).toBe("agent:main:voice:call:call-123");
  });

  it.each([
    {
      name: "the default core session",
      agentId: undefined,
      coreSession: undefined,
      expected: "agent:main:main",
    },
    {
      name: "a custom core main key",
      agentId: undefined,
      coreSession: { mainKey: "work" },
      expected: "agent:main:work",
    },
    {
      name: "global core scope",
      agentId: undefined,
      coreSession: { scope: "global" as const },
      expected: "global",
    },
    {
      name: "a configured agent",
      agentId: "ops",
      coreSession: undefined,
      expected: "agent:ops:main",
    },
  ])("routes main-scoped calls to $name", ({ agentId, coreSession, expected }) => {
    const config = resolveVoiceCallConfig({
      enabled: true,
      provider: "mock",
      sessionScope: "main",
      agentId,
    });

    expect(
      resolveVoiceCallSessionKey({
        config,
        callId: "call-123",
        phone: "+1 (555) 000-1111",
        coreSession,
      }),
    ).toBe(expected);
  });

  it("lets an explicit session key override main scope", () => {
    const config = resolveVoiceCallConfig({
      enabled: true,
      provider: "mock",
      sessionScope: "main",
    });

    expect(
      resolveVoiceCallSessionKey({
        config,
        callId: "call-123",
        phone: "+1 (555) 000-1111",
        explicitSessionKey: "Meet-Room-1",
      }),
    ).toBe("agent:main:meet-room-1");
  });

  it("scopes persisted and explicit keys at the agent session boundary", () => {
    const config = resolveVoiceCallConfig({
      enabled: true,
      provider: "mock",
      agentId: "Voice",
    });

    expect(
      resolveVoiceCallAgentSessionKey({
        config,
        sessionKey: "voice:call:legacy-call",
      }),
    ).toBe("agent:voice:voice:call:legacy-call");
    expect(
      resolveVoiceCallAgentSessionKey({
        config,
        sessionKey: "meet-room-1",
      }),
    ).toBe("agent:voice:meet-room-1");
    expect(
      resolveVoiceCallAgentSessionKey({
        config,
        sessionKey: "agent:main:shared-room",
      }),
    ).toBe("agent:voice:agent:main:shared-room");
    expect(
      resolveVoiceCallAgentSessionKey({
        config,
        sessionKey: "agent:other:Matrix:Channel:!RoomAbC:example.org",
      }),
    ).toBe("agent:voice:agent:other:matrix:channel:!RoomAbC:example.org");
    expect(
      resolveVoiceCallAgentSessionKey({
        config,
        sessionKey: "agent:voice:agent:other:matrix:channel:!RoomAbC:example.org",
      }),
    ).toBe("agent:voice:agent:other:matrix:channel:!RoomAbC:example.org");
    expect(
      resolveVoiceCallAgentSessionKey({
        config,
        sessionKey: "Signal:Group:AbC123=",
      }),
    ).toBe("agent:voice:signal:group:AbC123=");
    expect(
      resolveVoiceCallAgentSessionKey({
        config,
        sessionKey: "agent:broken",
      }),
    ).toBe("agent:voice:agent:broken");
    expect(
      resolveVoiceCallAgentSessionKey({
        config,
        sessionKey: "agent::broken",
      }),
    ).toBe("agent:voice:agent::broken");
    expect(
      resolveVoiceCallAgentSessionKey({
        config,
        sessionKey: "agent::Matrix:Channel:!RoomAbC:example.org",
      }),
    ).toBe("agent:voice:agent::matrix:channel:!RoomAbC:example.org");
    expect(
      resolveVoiceCallAgentSessionKey({
        config,
        sessionKey: "agent:other:room::part",
      }),
    ).toBe("agent:voice:agent:other:room::part");
    expect(
      resolveVoiceCallAgentSessionKey({
        config,
        sessionKey: "agent:voice:room::part",
      }),
    ).toBe("agent:voice:room::part");
    expect(
      resolveVoiceCallAgentSessionKey({
        config,
        sessionKey: "agent:voice::Matrix:Channel:!RoomAbC:example.org",
      }),
    ).toBe("agent:voice:agent:voice::matrix:channel:!RoomAbC:example.org");
    expect(
      resolveVoiceCallAgentSessionKey({
        config,
        sessionKey: "agent:bad/id:room",
      }),
    ).toBe("agent:voice:agent:bad/id:room");
  });

  it("canonicalizes raw and scoped main aliases with the core session config", () => {
    const config = resolveVoiceCallConfig({
      enabled: true,
      provider: "mock",
      agentId: "Voice",
    });

    for (const sessionKey of ["main", "agent:voice:main"]) {
      expect(
        resolveVoiceCallAgentSessionKey({
          config,
          sessionKey,
          coreSession: { mainKey: "work" },
        }),
      ).toBe("agent:voice:work");
    }
    expect(
      resolveVoiceCallAgentSessionKey({
        config,
        sessionKey: "main",
        coreSession: { scope: "global" },
      }),
    ).toBe("global");
    expect(
      resolveVoiceCallAgentSessionKey({
        config,
        sessionKey: "agent:main:main",
        coreSession: { mainKey: "work" },
      }),
    ).toBe("agent:voice:agent:main:main");
    expect(
      resolveVoiceCallAgentSessionKey({
        config,
        sessionKey: "agent:main:main",
        coreSession: { scope: "global" },
      }),
    ).toBe("agent:voice:agent:main:main");
  });

  it("resolves per-number inbound route overrides over global voice settings", () => {
    const config = resolveVoiceCallConfig({
      enabled: true,
      provider: "mock",
      inboundGreeting: "Hello from global.",
      agentId: "main",
      responseModel: "openai/gpt-5.4-mini",
      responseSystemPrompt: "Global voice assistant.",
      responseTimeoutMs: 10000,
      tts: {
        provider: "openai",
        providers: {
          openai: { voice: "coral", speed: 1 },
        },
      },
      numbers: {
        "+15550001111": {
          inboundGreeting: "Silver Fox Cards, how can I help?",
          agentId: "cards",
          responseModel: "openai/gpt-5.5",
          responseSystemPrompt: "You are a baseball card expert.",
          responseTimeoutMs: 20000,
          tts: {
            providers: {
              openai: { apiKey: "resolved-route-api-key", voice: "alloy" },
            },
          },
        },
      },
    });

    const effective = resolveVoiceCallEffectiveConfig(config, "+1 (555) 000-1111");

    expect(effective.numberRouteKey).toBe("+15550001111");
    expect(effective.config.inboundGreeting).toBe("Silver Fox Cards, how can I help?");
    expect(effective.config.agentId).toBe("cards");
    expect(effective.config.responseModel).toBe("openai/gpt-5.5");
    expect(effective.config.responseSystemPrompt).toBe("You are a baseball card expert.");
    expect(effective.config.responseTimeoutMs).toBe(20000);
    expect(effective.config.tts?.provider).toBe("openai");
    expect(effective.config.tts?.providers?.openai).toEqual({
      apiKey: "resolved-route-api-key",
      voice: "alloy",
      speed: 1,
    });
  });

  it("accepts every SecretRef source in per-number TTS provider config", () => {
    for (const apiKey of [
      envRef("VOICE_CALL_ROUTE_ENV_KEY"),
      { source: "file" as const, provider: "route-file", id: "/voice-call/apiKey" },
      { source: "exec" as const, provider: "route-exec", id: "voice-call/apiKey" },
      { source: "store" as const, provider: "default", id: "VOICE_CALL_ROUTE_STORE_KEY" },
    ]) {
      const config = VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "mock",
        numbers: {
          "+15550001111": { tts: { providers: { openai: { apiKey } } } },
        },
      });

      expect(config.numbers["+15550001111"]?.tts?.providers?.openai?.apiKey).toEqual(apiKey);
    }
  });

  it("falls back to global voice settings when no per-number route matches", () => {
    const config = resolveVoiceCallConfig({
      enabled: true,
      provider: "mock",
      inboundGreeting: "Hello from global.",
      numbers: {
        "+15550001111": {
          inboundGreeting: "Hello from route.",
        },
      },
    });

    const effective = resolveVoiceCallEffectiveConfig(config, "+15550002222");

    expect(effective.numberRouteKey).toBeUndefined();
    expect(effective.config).toBe(config);
    expect(effective.config.inboundGreeting).toBe("Hello from global.");
  });

  it("uses dialed-number fallback only for inbound calls", () => {
    expect(
      resolveVoiceCallNumberRouteKeyForCall({
        direction: "inbound",
        to: "+15550001111",
      }),
    ).toBe("+15550001111");
    expect(
      resolveVoiceCallNumberRouteKeyForCall({
        direction: "outbound",
        to: "+15550001111",
      }),
    ).toBeUndefined();
    expect(
      resolveVoiceCallNumberRouteKeyForCall({
        direction: "inbound",
        to: "+15550001111",
        metadata: { numberRouteKey: "+15550002222" },
      }),
    ).toBe("+15550002222");
    expect(
      resolveVoiceCallNumberRouteKeyForCall({
        direction: "outbound",
        to: "+15550001111",
        metadata: { numberRouteKey: "+15550002222" },
      }),
    ).toBeUndefined();
  });
});

describe("normalizeVoiceCallConfig", () => {
  it("fills nested runtime defaults from a partial config boundary", () => {
    const normalized = normalizeVoiceCallConfig({
      enabled: true,
      provider: "mock",
      streaming: {
        enabled: true,
        streamPath: "/custom-stream",
      },
    });

    expect(normalized.serve.path).toBe("/voice/webhook");
    expect(normalized.streaming.streamPath).toBe("/custom-stream");
    expect(normalized.streaming.provider).toBeUndefined();
    expect(normalized.streaming.providers).toStrictEqual({});
    expect(normalized.realtime.streamPath).toBe("/voice/stream/realtime");
    expect(normalized.realtime.toolPolicy).toBe("safe-read-only");
    expect(normalized.realtime.consultPolicy).toBe("auto");
    expect(normalized.realtime.fastContext).toEqual({
      enabled: false,
      timeoutMs: 800,
      maxResults: 3,
      sources: ["memory", "sessions"],
      fallbackToConsult: false,
    });
    expect(normalized.realtime.consultThinkingLevel).toBeUndefined();
    expect(normalized.realtime.consultFastMode).toBeUndefined();
    expect(normalized.realtime.agentContext).toEqual({
      enabled: false,
      maxChars: 6000,
      includeIdentity: true,
      includeWorkspaceFiles: true,
      files: ["SOUL.md", "IDENTITY.md", "USER.md"],
    });
    expect(normalized.realtime.instructions).toContain("openclaw_agent_consult");
    expect(normalized.realtime.instructions).toContain("openclaw_end_call");
    expect(normalized.realtime.instructions).toContain("speak any final words first");
    expect(normalized.tailscale.port).toBe(443);
    expect(normalized.tunnel.provider).toBe("none");
    expect(normalized.webhookSecurity.allowedHosts).toStrictEqual([]);
  });

  it("derives the realtime stream path from a custom webhook path", () => {
    const normalized = normalizeVoiceCallConfig({
      enabled: true,
      provider: "twilio",
      serve: {
        path: "/custom/webhook",
      },
    });

    expect(normalized.realtime.streamPath).toBe("/custom/stream/realtime");
  });

  it("accepts partial nested TTS overrides and preserves nested objects", () => {
    const normalized = normalizeVoiceCallConfig({
      tts: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: {
              source: "env",
              provider: "elevenlabs",
              id: "ELEVENLABS_API_KEY",
            },
            voiceSettings: {
              speed: 1.1,
            },
          },
        },
      },
    });

    const { tts, elevenlabs } = requireElevenLabsTtsConfig(normalized);
    expect(tts.provider).toBe("elevenlabs");
    expect(elevenlabs.apiKey).toEqual({
      source: "env",
      provider: "elevenlabs",
      id: "ELEVENLABS_API_KEY",
    });
    expect(elevenlabs.voiceSettings).toEqual({ speed: 1.1 });
  });
});

describe("resolveVoiceCallStreamExposurePaths", () => {
  it("returns no paths when both audio modes are disabled", () => {
    const config = normalizeVoiceCallConfig({});

    expect(resolveVoiceCallStreamExposurePaths(config)).toEqual([]);
  });

  it("derives the default realtime path from the webhook path", () => {
    const config = normalizeVoiceCallConfig({
      serve: { path: "/custom/webhook" },
      realtime: { enabled: true },
    });

    expect(resolveVoiceCallStreamExposurePaths(config)).toEqual([
      {
        localPath: "/custom/stream/realtime",
        publicPath: "/custom/stream/realtime",
      },
    ]);
  });

  it("normalizes explicit realtime and streaming paths", () => {
    const config = normalizeVoiceCallConfig({
      realtime: { enabled: true, streamPath: "custom/realtime" },
      streaming: { enabled: true, streamPath: "custom/stream" },
    });

    expect(resolveVoiceCallStreamExposurePaths(config)).toEqual([
      { localPath: "/custom/realtime", publicPath: "/custom/realtime" },
      { localPath: "/custom/stream", publicPath: "/custom/stream" },
    ]);
  });

  it("deduplicates equal realtime and streaming paths", () => {
    const config = normalizeVoiceCallConfig({
      realtime: { enabled: true, streamPath: "/voice/stream" },
      streaming: { enabled: true, streamPath: "/voice/stream" },
    });

    expect(resolveVoiceCallStreamExposurePaths(config)).toEqual([
      { localPath: "/voice/stream", publicPath: "/voice/stream" },
    ]);
  });

  it("maps stream paths through a distinct public Tailscale prefix", () => {
    const config = normalizeVoiceCallConfig({
      serve: { path: "/voice/webhook" },
      tailscale: { path: "/edge/voice/webhook" },
      realtime: { enabled: true },
      streaming: { enabled: true, streamPath: "/voice/stream" },
    });

    expect(resolveVoiceCallStreamExposurePaths(config)).toEqual([
      {
        localPath: "/voice/stream/realtime",
        publicPath: "/edge/voice/stream/realtime",
      },
      { localPath: "/voice/stream", publicPath: "/voice/stream" },
    ]);
  });
});

describe("resolveVoiceCallConfig realtime settings", () => {
  it("preserves configured realtime instructions without env indirection", () => {
    const resolved = resolveVoiceCallConfig({
      enabled: true,
      provider: "twilio",
      realtime: {
        enabled: true,
        instructions: "Stay concise.",
      },
    });

    expect(resolved.realtime.instructions).toBe("Stay concise.");
    expect(resolved.realtime.toolPolicy).toBe("safe-read-only");
    expect(resolved.realtime.consultPolicy).toBe("auto");
    expect(resolved.realtime.provider).toBeUndefined();
  });

  it("preserves configured realtime consult overrides", () => {
    const resolved = resolveVoiceCallConfig({
      enabled: true,
      provider: "mock",
      realtime: {
        consultThinkingLevel: "ultra",
        consultFastMode: true,
      },
    });

    expect(resolved.realtime.consultThinkingLevel).toBe("ultra");
    expect(resolved.realtime.consultFastMode).toBe(true);
  });

  it("rejects invalid realtime consult thinking levels", () => {
    expect(() =>
      resolveVoiceCallConfig({
        enabled: true,
        provider: "mock",
        realtime: {
          consultThinkingLevel: "turbo",
        },
      } as never),
    ).toThrow(/Invalid option/);
  });

  it("leaves responseModel unset so voice responses can inherit runtime defaults", () => {
    const resolved = resolveVoiceCallConfig({
      enabled: true,
      provider: "mock",
    });

    expect(resolved.responseModel).toBeUndefined();
  });

  it("preserves the configured voice response agent id", () => {
    const resolved = resolveVoiceCallConfig({
      enabled: true,
      provider: "mock",
      agentId: "voice",
    });

    expect(resolved.agentId).toBe("voice");
  });
});
