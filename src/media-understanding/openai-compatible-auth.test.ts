import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../agents/model-auth-markers.js";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "./audio.test-helpers.js";
import { transcribeOpenAiCompatibleAudio } from "./openai-compatible-audio.js";
import { describeOpenAiCompatibleVideo } from "./openai-compatible-video.js";
import type { AudioTranscriptionRequest } from "./types.js";

installPinnedHostnameTestHooks();

describe.each([
  { capability: "audio", send: transcribeOpenAiCompatibleAudio, errorLabel: "Audio transcription" },
  {
    capability: "video",
    send: describeOpenAiCompatibleVideo,
    errorLabel: "Local media video description",
  },
])("OpenAI-compatible $capability authentication", ({ send, errorLabel }) => {
  const defaults = {
    buffer: Buffer.from("media"),
    fileName: "media.bin",
    apiKey: "legacy-key",
    timeoutMs: 1000,
    provider: "local-media",
    defaultBaseUrl: "https://media.example.com/v1",
    defaultModel: "local-model",
    defaultPrompt: "Describe the media.",
    providerLabel: "Local media",
  };
  it.each<{
    name: string;
    request: Partial<Pick<AudioTranscriptionRequest, "apiKey" | "auth" | "headers" | "request">>;
    authorization: string | null;
    customHeader?: string;
  }>([
    {
      name: "explicit no-auth suppresses the legacy marker",
      request: {
        apiKey: CUSTOM_LOCAL_AUTH_MARKER,
        auth: { kind: "none", source: "local provider" },
      },
      authorization: null,
    },
    {
      name: "typed API key takes precedence over the legacy key",
      request: { auth: { kind: "api-key", apiKey: "typed-key" } },
      authorization: "Bearer typed-key",
    },
    {
      name: "legacy API key remains supported",
      request: {},
      authorization: "Bearer legacy-key",
    },
    {
      name: "empty legacy API key omits the bearer header",
      request: { apiKey: "" },
      authorization: null,
    },
    {
      name: "caller headers override provider auth and request overrides",
      request: {
        auth: { kind: "none", source: "local provider" },
        headers: { Authorization: "Bearer caller-key" },
        request: { auth: { mode: "authorization-bearer", token: "request-key" } },
      },
      authorization: "Bearer caller-key",
    },
    {
      name: "configured bearer overrides provider no-auth",
      request: {
        auth: { kind: "none", source: "local provider" },
        request: { auth: { mode: "authorization-bearer", token: "request-key" } },
      },
      authorization: "Bearer request-key",
    },
    {
      name: "configured custom auth replaces the provider bearer header",
      request: {
        auth: { kind: "api-key", apiKey: "typed-key" },
        request: { auth: { mode: "header", headerName: "X-Custom-Key", value: "custom-key" } },
      },
      authorization: null,
      customHeader: "custom-key",
    },
  ])("$name", async ({ request, authorization, customHeader }) => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      text: "ok",
      choices: [{ message: { content: "ok" } }],
    });
    const result = await send({
      ...defaults,
      fetchFn,
      ...request,
    });

    expect(result.text).toBe("ok");
    const headers = new Headers(getRequest().init?.headers);
    expect(headers.get("authorization")).toBe(authorization);
    expect(headers.get("x-custom-key")).toBe(customHeader ?? null);
  });

  it.each([400, 200])(
    "redacts reflected request credentials from HTTP %s diagnostics",
    async (status) => {
      const credential = "synthetic-only";
      const fetchFn = vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
        return new Response(
          status === 400
            ? JSON.stringify({ error: { message: `Rejected ${credential}`, code: credential } })
            : credential,
          { status, headers: { "x-request-id": credential } },
        );
      });

      const error = await send({
        ...defaults,
        headers: { authorization: `Bearer ${credential}` },
        fetchFn,
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        message:
          status === 400
            ? `${errorLabel} failed (HTTP 400): Rejected *** [code=***] [request_id=***]`
            : `${errorLabel} failed: malformed JSON response`,
      });
      expect(inspect(error)).not.toContain(credential);
    },
  );
});
