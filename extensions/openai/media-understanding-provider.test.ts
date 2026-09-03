// Openai tests cover media understanding provider plugin behavior.
import { inspect } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import {
  createAuthCaptureJsonFetch,
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-media-understanding";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openaiMediaUnderstandingProvider } from "./media-understanding-provider.js";

const authMocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: authMocks.resolve,
}));

installPinnedHostnameTestHooks();

beforeEach(() => {
  authMocks.resolve.mockReset();
});

describe("openaiMediaUnderstandingProvider", () => {
  it("declares audio support with the transcription default", () => {
    expect(openaiMediaUnderstandingProvider.capabilities).toEqual(["image", "audio"]);
    expect(openaiMediaUnderstandingProvider.defaultModels).toEqual({
      image: "gpt-5.6-sol",
      audio: "gpt-4o-transcribe",
    });
    expect(openaiMediaUnderstandingProvider.autoPriority).toEqual({ image: 20, audio: 20 });
    expect(openaiMediaUnderstandingProvider.transcribeAudio).toBeTypeOf("function");
  });
});

describe("provider-owned audio transcription", () => {
  const token = "fixture-oauth-token";

  function useOAuth() {
    authMocks.resolve.mockResolvedValue({
      apiKey: token,
      mode: "oauth",
      source: "profile:openai:audio",
    });
  }

  it.each([
    [undefined, undefined],
    [undefined, "gpt-4o-mini-transcribe"],
    ["https://api.openai.com", "gpt-4o-mini-transcribe"],
    ["https://chatgpt.com/backend-api/codex", "gpt-4o-mini-transcribe"],
  ])(
    "routes subscription audio from official base %s with model %s to the standard transcription endpoint",
    async (baseUrl, model) => {
      useOAuth();
      const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "Hallo" });
      const result = await openaiMediaUnderstandingProvider.transcribeAudioWithContext!({
        cfg: {},
        agentDir: "/fixture/agents/audio",
        profile: "openai:audio",
        baseUrl,
        buffer: Buffer.from("audio"),
        fileName: "voice.wav",
        language: "de",
        model,
        prompt: "Names: Ada",
        timeoutMs: 1000,
        fetchFn,
      });
      const { url, init } = getRequest();
      expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(new Headers(init?.headers).has("ChatGPT-Account-ID")).toBe(false);
      const body = expectDefined(init?.body, "transcription request body") as FormData;
      expect(body.get("language")).toBe("de");
      expect(body.get("model")).toBe(model ?? "gpt-4o-transcribe");
      expect(body.get("prompt")).toBe("Names: Ada");
      expect(result).toEqual({
        ok: true,
        value: { text: "Hallo", model: model ?? "gpt-4o-transcribe" },
      });
      expect(authMocks.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          agentDir: "/fixture/agents/audio",
          profileId: "openai:audio",
          lockedProfile: true,
        }),
      );
    },
  );

  it.each([undefined, "", " \t "])(
    "resolves subscription auth through the real resolver with absent key %j",
    async (apiKey) =>
      withEnvAsync({ OPENAI_API_KEY: undefined }, async () => {
        const [
          { createPluginRegistryFixture },
          { createPluginRecord },
          { withPluginRuntimeRegistryScope },
          { default: plugin },
        ] = await Promise.all([
          import("openclaw/plugin-sdk/plugin-test-contracts"),
          import("openclaw/plugin-sdk/plugin-test-runtime"),
          import("openclaw/plugin-sdk/channel-test-helpers"),
          import("./index.js"),
        ]);
        const cfg = {
          auth: { order: { openai: ["openai:fixture-subscription"] } },
          models: {
            providers: {
              openai: { apiKey, baseUrl: "https://api.openai.com/v1", models: [] },
            },
          },
        };
        const { registry } = createPluginRegistryFixture(cfg);
        const record = createPluginRecord({ id: "openai" });
        registry.registry.plugins.push(record);
        // Capability discovery registers the provider before its media callback runs.
        plugin.register(registry.createApi(record, { config: cfg, registrationMode: "discovery" }));
        const realAuth = await vi.importActual<
          typeof import("openclaw/plugin-sdk/provider-auth-runtime")
        >("openclaw/plugin-sdk/provider-auth-runtime");
        authMocks.resolve.mockImplementation((params) =>
          realAuth.resolveApiKeyForProvider({
            ...params,
            store: {
              version: 1,
              profiles: {
                "openai:fixture-subscription": { type: "token", provider: "openai", token },
              },
            },
          }),
        );
        try {
          await withPluginRuntimeRegistryScope(registry.registry, async () => {
            const provider = registry.registry.mediaUnderstandingProviders.find(
              (entry) => entry.provider.id === "openai",
            )?.provider;
            if (!provider?.transcribeAudioWithContext) {
              throw new Error("OpenAI audio transcription registration missing");
            }
            const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "subscription" });
            const result = await provider.transcribeAudioWithContext({
              cfg,
              buffer: Buffer.from("audio"),
              fileName: "voice.wav",
              timeoutMs: 1000,
              fetchFn,
            });
            expect(result.ok).toBe(true);
            expect(getRequest().url).toBe("https://api.openai.com/v1/audio/transcriptions");
            expect(new Headers(getRequest().init?.headers).get("authorization")).toBe(
              `Bearer ${token}`,
            );
            expect(authMocks.resolve).toHaveBeenCalledTimes(2);
          });
        } finally {
          registry.rollbackPluginGlobalSideEffects(record.id, record);
        }
      }),
  );

  it.each([
    ["https://api.openai.com/v1", "https://api.openai.com/v1/audio/transcriptions"],
    ["https://chatgpt.com/backend-api/codex", "https://api.openai.com/v1/audio/transcriptions"],
    ["https://custom.example/v1", "https://custom.example/v1/audio/transcriptions"],
  ])(
    "keeps an authored API key ahead of OAuth with provider base %s",
    async (baseUrl, expectedUrl) => {
      authMocks.resolve.mockResolvedValue({
        apiKey: "fixture-platform-key",
        mode: "api-key",
        source: "models.json",
      });
      const cfg = {
        auth: { order: { openai: ["openai:chatgpt", "openai:audio"] } },
        models: {
          providers: {
            openai: {
              baseUrl,
              apiKey: "fixture-platform-key",
              models: [],
            },
          },
        },
      };
      const original = structuredClone(cfg);
      const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });
      await openaiMediaUnderstandingProvider.transcribeAudioWithContext!({
        cfg,
        baseUrl,
        buffer: Buffer.from("audio"),
        fileName: "voice.wav",
        model: "gpt-4o-mini-transcribe",
        prompt: "Names: Ada",
        timeoutMs: 1000,
        fetchFn,
      });
      expect(cfg).toEqual(original);
      expect(authMocks.resolve).toHaveBeenCalledTimes(1);
      expect(authMocks.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          modelApi: "openai-audio-transcriptions",
          cfg: expect.objectContaining({
            models: { providers: { openai: { ...cfg.models.providers.openai, auth: "api-key" } } },
          }),
        }),
      );
      const { url, init } = getRequest();
      expect(url).toBe(expectedUrl);
      const body = expectDefined(init?.body, "transcription request body") as FormData;
      expect(body.get("model")).toBe("gpt-4o-mini-transcribe");
      expect(body.get("prompt")).toBe("Names: Ada");
    },
  );

  it.each([
    { baseUrl: "https://custom.example/v1" },
    { baseUrl: "https://api.openai.com:8443/v1" },
    { baseUrl: "https://api.openai.com/v1?alternate=true" },
    { headers: { authorization: "Bearer other" } },
  ])("rejects unsupported subscription request settings before upload: %j", async (settings) => {
    useOAuth();
    await expect(
      openaiMediaUnderstandingProvider.transcribeAudioWithContext!({
        cfg: {},
        buffer: Buffer.from("audio"),
        fileName: "voice.wav",
        timeoutMs: 1000,
        profile: "openai:audio",
        ...settings,
      }),
    ).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ message: expect.stringMatching(/API-key profile/) }),
    });
  });

  it("does not switch billing routes after an authored credential failure", async () => {
    const failure = new Error("selected profile could not refresh");
    authMocks.resolve.mockRejectedValue(failure);
    await expect(
      openaiMediaUnderstandingProvider.transcribeAudioWithContext!({
        cfg: {},
        buffer: Buffer.from("audio"),
        fileName: "voice.wav",
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({ ok: false, error: failure });
    expect(authMocks.resolve).toHaveBeenCalledTimes(1);
  });

  it.each([400, 200])(
    "redacts reflected request credentials from HTTP %s diagnostics",
    async (status) => {
      const credential = "synthetic-only";
      authMocks.resolve.mockResolvedValue({
        apiKey: credential,
        mode: "oauth",
        profileId: "openai:fixture",
        source: "profile:openai:fixture",
      });
      const fetchFn = vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
        return new Response(
          status === 400
            ? JSON.stringify({ error: { message: `Rejected ${credential}`, code: credential } })
            : credential,
          { status, headers: { "x-request-id": credential } },
        );
      });
      const error = await openaiMediaUnderstandingProvider.transcribeAudioWithContext!({
        cfg: {},
        buffer: Buffer.from("audio"),
        fileName: "voice.wav",
        timeoutMs: 1000,
        fetchFn,
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        message:
          status === 400
            ? "Audio transcription failed (HTTP 400): Rejected *** [code=***] [request_id=***]"
            : "Audio transcription failed: malformed JSON response",
      });
      expect(inspect(error)).not.toContain(credential);
      expect(authMocks.resolve).toHaveBeenCalledTimes(1);
    },
  );
});

describe("transcribeOpenAiAudio", () => {
  it("respects lowercase authorization header overrides", async () => {
    const { fetchFn, getAuthHeader } = createAuthCaptureJsonFetch({ text: "ok" });

    const result = await openaiMediaUnderstandingProvider.transcribeAudio!({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 1000,
      headers: { authorization: "Bearer override" },
      fetchFn,
    });

    expect(getAuthHeader()).toBe("Bearer override");
    expect(result.text).toBe("ok");
  });

  it("builds the expected request payload", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });

    const result = await openaiMediaUnderstandingProvider.transcribeAudio!({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.wav",
      apiKey: "test-key",
      timeoutMs: 1234,
      baseUrl: "https://api.example.com/v1/",
      model: " ",
      language: " en ",
      prompt: " hello ",
      mime: "audio/wav",
      headers: { "X-Custom": "1" },
      fetchFn,
    });
    const { url: seenUrl, init: seenInit } = getRequest();

    expect(result.model).toBe("gpt-4o-transcribe");
    expect(result.text).toBe("hello");
    expect(seenUrl).toBe("https://api.example.com/v1/audio/transcriptions");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(seenInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("x-custom")).toBe("1");

    const form = seenInit?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBe("hello");
    const file = form.get("file") as Blob | { type?: string; name?: string } | null;
    if (!file) {
      throw new Error("expected OpenAI audio file");
    }
    expect(file.type).toBe("audio/wav");
    if (file && "name" in file && typeof file.name === "string") {
      expect(file.name).toBe("voice.wav");
    }
  });

  it("throws when the provider response omits text", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({});

    await expect(
      openaiMediaUnderstandingProvider.transcribeAudio!({
        buffer: Buffer.from("audio-bytes"),
        fileName: "voice.wav",
        apiKey: "test-key",
        timeoutMs: 1234,
        fetchFn,
      }),
    ).rejects.toThrow("Audio transcription response missing text");
  });
});
