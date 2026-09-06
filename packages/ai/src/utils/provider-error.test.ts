import { APIError } from "openai/core/error";
import { describe, expect, it } from "vitest";
import { configureProviderErrorRedactor, projectProviderError } from "./provider-error.js";

describe("projectProviderError", () => {
  it.each([
    ["335", 7],
    ["8500", 8.5],
  ])(
    "preserves SDK retry timing without exposing unrelated headers (%s ms)",
    (milliseconds, seconds) => {
      const error = new APIError(
        429,
        { message: "rate limited" },
        undefined,
        new Headers({
          "retry-after": "7",
          "retry-after-ms": milliseconds,
          authorization: "Bearer synthetic-credential",
        }),
      );
      const projection = projectProviderError(error);
      expect(projection.errorMessage).toContain(`Retry-After: ${seconds} seconds`);
      expect(projection.errorBody).toBe('{"message":"rate limited"}');
      expect(JSON.stringify(projection)).not.toContain("synthetic-credential");
    },
  );

  it("reserves room for retry timing after truncating a long SDK message", () => {
    const error = new APIError(
      429,
      undefined,
      "x".repeat(5000),
      new Headers({ "retry-after": "7" }),
    );
    const projection = projectProviderError(error);
    expect(projection.errorMessage).toHaveLength(4096);
    expect(projection.errorMessage).toMatch(/; Retry-After: 7 seconds$/);
  });

  it.each([
    {
      name: "JSON body",
      error: Object.assign(new Error("403 status code (no body)"), {
        status: 403,
        error: { message: "blocked by gateway" },
      }),
      expected: '403: {"message":"blocked by gateway"}',
    },
    {
      name: "text body",
      error: Object.assign(new Error("502 status code (no body)"), {
        status: 502,
        body: "proxy unavailable",
      }),
      expected: "502: proxy unavailable",
    },
    {
      name: "no body",
      error: Object.assign(new Error("503 status code (no body)"), { status: 503 }),
      expected: "503 status code (no body)",
    },
  ])("formats an HTTP error with $name", ({ error, expected }) => {
    expect(projectProviderError(error).errorMessage).toBe(expected);
  });

  it("preserves an SDK message that already contains the response body", () => {
    const body = '{"error":{"message":"permission denied"}}';
    const error = Object.assign(new Error(body), { status: 403, body });

    expect(projectProviderError(error).errorMessage).toBe(body);
  });

  it("preserves a meaningful SDK message alongside its structured body", () => {
    const error = Object.assign(new Error("400 Param Incorrect"), {
      status: 400,
      error: { code: "invalid_parameter", message: "parameter detail" },
    });

    expect(projectProviderError(error)).toMatchObject({
      errorMessage: "400 Param Incorrect",
      errorBody: '{"code":"invalid_parameter","message":"parameter detail"}',
    });
  });

  it("preserves diagnostic fields when serializing a circular error object", () => {
    const error: Record<string, unknown> = { code: "ECONNRESET" };
    error.self = error;

    expect(projectProviderError(error).errorMessage).toBe(
      '{"code":"ECONNRESET","self":"[Circular]"}',
    );
  });

  it("normalizes string and finite-number provider error fields", () => {
    expect(
      projectProviderError({
        message: "  provider failure  ",
        code: 12.5,
        type: "  upstream  ",
      }),
    ).toMatchObject({
      errorMessage: "provider failure",
      errorCode: "12.5",
      errorType: "upstream",
    });
    expect(
      projectProviderError({ message: "failed", code: Number.POSITIVE_INFINITY }),
    ).not.toHaveProperty("errorCode");
  });

  it("bounds repeated aliases without expanding the shared graph", () => {
    const shared = { detail: "safe" };

    expect(projectProviderError({ first: shared, second: shared }).errorMessage).toBe(
      '{"first":{"detail":"safe"},"second":"[Circular]"}',
    );
  });

  it("does not split surrogate pairs when truncating response bodies", () => {
    const body = `${"x".repeat(3999)}😀tail`;
    const error = Object.assign(new Error("502 status code (no body)"), { status: 502, body });

    expect(projectProviderError(error).errorMessage).toBe(
      `502: ${"x".repeat(3999)}... [truncated]`,
    );
  });

  it("bounds repeated structured diagnostic fragments before extraction", () => {
    expect(projectProviderError("{}".repeat(8193)).errorMessage).toBe(
      "[Oversized diagnostic JSON redacted]",
    );
  });

  it.each([
    {
      name: "Error.message",
      error: new Error("failed data:video/mp4;base64,QUJDRA=="),
      expected: "failed <redacted>",
    },
    {
      name: "string throw",
      error: "failed data:audio/mpeg;base64,QUJDRA==",
      expected: "failed <redacted>",
    },
    {
      name: "structured response body",
      error: Object.assign(new Error("415 status code (no body)"), {
        status: 415,
        body: { type: "video", data: "QUJDRA==" },
      }),
      expected: '415: {"data":{"bytes":4,"redacted":"<redacted>"},"type":"video"}',
    },
    {
      name: "prefixed JSON message",
      error: new Error('Error: {"b64_json":"QUJDRA=="}'),
      expected: 'Error: {"b64_json":"<redacted>"}',
    },
    {
      name: "credential in a JSON message prefix",
      error: new Error('Provider token=abcdefghijklmnop : {"b64_json":"QUJDRA=="}'),
      expected: 'Provider token=<redacted> : {"b64_json":"<redacted>"}',
    },
    {
      name: "bracketed provider prefix",
      error: new Error('Error [provider]: {"b64_json":"QUJDRA=="}'),
      expected: 'Error [provider]: {"b64_json":"<redacted>"}',
    },
    {
      name: "provider prefix without a delimiter",
      error: new Error('Error [provider] {"b64_json":"QUJDRA=="}'),
      expected: 'Error [provider] {"b64_json":"<redacted>"}',
    },
    {
      name: "multiline provider prefix",
      error: new Error('Error from\nprovider: {"b64_json":"QUJDRA=="}'),
      expected: 'Error from\nprovider: {"b64_json":"<redacted>"}',
    },
    {
      name: "long provider prefix",
      error: new Error(`${"x".repeat(129)}: {"b64_json":"QUJDRA=="}`),
      expected: `${"x".repeat(129)}: {"b64_json":"<redacted>"}`,
    },
    {
      name: "suffixed Anthropic JSON message",
      error: new Error(
        'HTTP 429: {"type":"error","error":{"message":"safe","b64_json":"QUJDRA=="}}; Retry-After: 30 seconds',
      ),
      expected:
        'HTTP 429: {"error":{"b64_json":"<redacted>","message":"safe"},"type":"error"}; Retry-After: 30 seconds',
    },
    {
      name: "bracket-tagged JSON message",
      error: new Error('[ERROR] payload {"type":"video","data":"QUJDRA=="}'),
      expected: '[ERROR] payload {"data":{"bytes":4,"redacted":"<redacted>"},"type":"video"}',
    },
    {
      name: "harmless JSON before sensitive JSON",
      error: new Error('meta {"ok":true} payload {"type":"video","data":"QUJDRA=="}'),
      expected:
        'meta {"ok":true} payload {"data":{"bytes":4,"redacted":"<redacted>"},"type":"video"}',
    },
    {
      name: "two sensitive JSON fragments",
      error: new Error('first {"b64_json":"QUJDRA=="} second {"b64_json":"QUJDRA=="}'),
      expected: 'first {"b64_json":"<redacted>"} second {"b64_json":"<redacted>"}',
    },
  ])("redacts media from $name", ({ error, expected }) => {
    expect(projectProviderError(error).errorMessage).toBe(expected);
  });

  it.each([
    { name: "audio string", key: "audio", value: "QUJDRA==" },
    { name: "image numeric bytes", key: "image", value: [65, 66, 67, 68] },
    { name: "video typed bytes", key: "video", value: new Uint8Array([65, 66, 67, 68]) },
  ])("redacts a direct $name field", ({ key, value }) => {
    expect(projectProviderError({ status: 500, body: { [key]: value } }).errorBody).toBe(
      `{"${key}":{"bytes":4,"redacted":"<redacted>"}}`,
    );
  });

  it.each([
    ["string chunks", ["QUJDRA=="]],
    ["numeric chunks", [[65, 66, 67, 68]]],
  ])("redacts media arrays containing %s", (_name, videoFrames) => {
    expect(
      JSON.stringify(projectProviderError({ status: 500, body: { videoFrames } })),
    ).not.toMatch(/QUJDRA==|65,66,67,68/u);
  });

  it.each([
    ["imageBytes", true],
    ["imageBase64", true],
    ["audioData", true],
    ["audioDelta", true],
    ["videoData", true],
    ["videoUrl", true],
    ["videoUri", true],
    ["videoFileUri", true],
    ["inputImage", true],
    ["outputVideo", true],
    ["video_bytes_base64", true],
    ["imageDataBase64", true],
    ["video_frame", true],
    ["videoFrame", true],
    ["outputVideoFrames", true],
    ["audioCodec", false],
  ])("classifies normalized media field %s", (key, redacted) => {
    const value = `media-value-for-${key}`;
    const serialized = JSON.stringify(
      projectProviderError({ status: 500, body: { [key]: value } }),
    );

    expect(serialized.includes(value)).toBe(!redacted);
  });

  it.each([
    {
      name: "nested videoBytes",
      body: '{"generatedVideos":[{"video":{"videoBytes":"QUJDRA=="}}]}',
      leaked: "QUJDRA==",
    },
    { name: "bare b64_json", body: '{"b64_json":"QUJDRA=="}', leaked: "QUJDRA==" },
    {
      name: "typed video data",
      body: '{"type":"video","data":"QUJDRA=="}',
      leaked: "QUJDRA==",
    },
    {
      name: "typed numeric video data",
      body: '{"type":"video","data":[65,66,67,68]}',
      leaked: "[65,66,67,68]",
    },
    {
      name: "image generation result",
      body: '{"type":"image_generation_call","result":"QUJDRA=="}',
      leaked: "QUJDRA==",
    },
    {
      name: "typed video URI",
      body: '{"type":"video","uri":"https://media.invalid/private"}',
      leaked: "https://media.invalid/private",
    },
    {
      name: "MIME-qualified file URI",
      body: '{"mimeType":"video/mp4","fileUri":"https://media.invalid/signed"}',
      leaked: "https://media.invalid/signed",
    },
    { name: "audio wrapper data", body: '{"audio":{"data":"QUJDRA=="}}', leaked: "QUJDRA==" },
    { name: "video wrapper blob", body: '{"video":{"blob":"QUJDRA=="}}', leaked: "QUJDRA==" },
    {
      name: "video frame wrapper data",
      body: '{"video_frame":{"data":"QUJDRA=="}}',
      leaked: "QUJDRA==",
    },
    {
      name: "camel-case video frame wrapper data",
      body: '{"videoFrame":{"data":"QUJDRA=="}}',
      leaked: "QUJDRA==",
    },
    {
      name: "camel-case input video frame wrapper data",
      body: '{"inputVideoFrame":{"data":"QUJDRA=="}}',
      leaked: "QUJDRA==",
    },
    {
      name: "output audio wrapper data",
      body: '{"output_audio":{"data":"QUJDRA=="}}',
      leaked: "QUJDRA==",
    },
    {
      name: "audio wrapper bytes",
      body: '{"audio":{"bytes":[65,66,67,68]}}',
      leaked: "[65,66,67,68]",
    },
    {
      name: "video wrapper buffer",
      body: '{"video":{"buffer":"QUJDRA=="}}',
      leaked: "QUJDRA==",
    },
    {
      name: "plural video container URL",
      body: '{"videos":[{"url":"https://media.invalid/private/path-token"}]}',
      leaked: "https://media.invalid/private/path-token",
    },
    {
      name: "array following a JSON literal",
      body: '[true,{"b64_json":"QUJDRA=="}]',
      leaked: "QUJDRA==",
    },
  ])("redacts $name from a JSON response-body string", ({ body, leaked }) => {
    const projected = projectProviderError({ status: 500, body });

    expect(JSON.stringify(projected)).not.toContain(leaked);
  });

  it("preserves a harmless JSON response-body string byte-for-byte", () => {
    const body = '{"message": "safe", "nested": [1, 2]}';

    expect(projectProviderError({ status: 500, body }).errorBody).toBe(body);
  });

  it.each([
    {
      name: "duplicate credential value",
      body: '{"name":"password","value":"actual-secret","value":"<redacted>"}',
      expected: '{"name":"password","value":"<redacted>"}',
    },
    {
      name: "value-equal duplicate media marker",
      body: '{"videoUrl":"https://media.invalid/actual-secret","videoUrl":"<redacted>"}',
      expected: '{"videoUrl":"<redacted>"}',
    },
  ])("canonicalizes sensitive JSON with $name", ({ body, expected }) => {
    expect(projectProviderError({ status: 500, body }).errorBody).toBe(expected);
  });

  it.each([
    "[ERROR] provider unavailable",
    "[GoogleGenerativeAI Error]: provider unavailable",
    "[429] rate limited: retry later",
    "Error: [GoogleGenerativeAI Error]: provider unavailable",
  ])("preserves plain bracketed diagnostic text", (body) => {
    expect(projectProviderError({ status: 500, body }).errorBody).toBe(body);
  });

  it.each(['[ERROR] payload "type":"video","data":"QUJDRA=="'])(
    "fails closed when bracketed diagnostic text contains a malformed structured payload",
    (body) => {
      expect(projectProviderError({ status: 500, body }).errorBody).toBe(
        "[Malformed diagnostic JSON redacted]",
      );
    },
  );

  it.each([
    '{"type":"video","data":"QUJDRA=="',
    'Error: {"type":"video","data":"QUJDRA=="',
    'meta {"ok":true} payload {"type":"video","data":"QUJDRA=="',
    '[ERROR] payload "type":"video","data":"QUJDRA==" context {"ok":true}',
    'meta {"ok":true} payload type:video,data:"QUJDRA=="',
    'payload "b64_json" {} : "QUJDRA=="',
    '[undefined,{"b64_json":"QUJDRA=="}]',
  ])("fails closed for malformed JSON response-body strings", (body) => {
    const projected = projectProviderError({ status: 500, body });

    expect(JSON.stringify(projected)).not.toContain("QUJDRA==");
    expect(projected.errorBody).toBe("[Malformed diagnostic JSON redacted]");
  });

  it("retains readable status and body from a hostile non-Error value", () => {
    const error = {
      status: 429,
      body: "retry after data:image/png;base64,QUJDRA==",
      get hostile() {
        throw new Error("getter failed");
      },
    };

    expect(projectProviderError(error).errorMessage).toBe("429: retry after <redacted>");
  });

  it("does not invoke hostile terminal-field accessors without a host", () => {
    const error = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(error, {
      safe: { enumerable: true, value: "connection failed" },
      status: {
        enumerable: true,
        get: () => {
          throw new Error("status getter");
        },
      },
      body: {
        enumerable: true,
        get: () => {
          throw new Error("body getter");
        },
      },
      message: {
        enumerable: true,
        get: () => {
          throw new Error("message getter");
        },
      },
    });

    expect(() => projectProviderError(error)).not.toThrow();
    expect(projectProviderError(error).errorMessage).toContain("connection failed");
  });

  it("never throws when a proxy revokes itself after descriptor collection", () => {
    const revocable = Proxy.revocable([], {
      ownKeys: Reflect.ownKeys,
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key === "length") {
          revocable.revoke();
        }
        return descriptor;
      },
    });

    const projected = projectProviderError(revocable.proxy);

    expect(projected.stopReason).toBe("error");
    expect(projected.errorMessage).toBe("[Unserializable]");
  });

  it("caps descriptor reads from hostile objects", () => {
    let descriptorReads = 0;
    const keys = Array.from({ length: 1_000 }, (_, index) => `field${index}`);
    const error = new Proxy(
      {},
      {
        ownKeys: () => keys,
        getOwnPropertyDescriptor: (_target, key) => {
          descriptorReads += 1;
          return { configurable: true, enumerable: true, value: String(key) };
        },
      },
    );

    expect(projectProviderError(error).stopReason).toBe("error");
    expect(descriptorReads).toBe(64);
  });

  it("caps descriptor reads across a branching hostile graph", () => {
    let descriptorReads = 0;
    const keys = Array.from({ length: 64 }, (_, index) => `field${index}`);
    const createNode = (): object =>
      new Proxy(
        {},
        {
          ownKeys: () => keys,
          getOwnPropertyDescriptor: () => {
            descriptorReads += 1;
            return { configurable: true, enumerable: true, value: createNode() };
          },
        },
      );

    expect(projectProviderError(createNode()).stopReason).toBe("error");
    expect(descriptorReads).toBe(64 * 64);
  });

  it("skips proxy keys without property descriptors", () => {
    const error = new Proxy(
      { safe: "connection failed" },
      {
        ownKeys: () => ["missing", "safe"],
        getOwnPropertyDescriptor: (target, key) => Reflect.getOwnPropertyDescriptor(target, key),
      },
    );

    expect(projectProviderError(error).errorMessage).toContain("connection failed");
  });

  it("redacts value fields when their discriminator falls beyond the field cap", () => {
    const secret = "late-discriminator-secret";
    const error: Record<string, unknown> = { value: secret };
    for (let index = 0; index < 63; index += 1) {
      error[`field${index}`] = index;
    }
    error.name = "api_key";

    expect(JSON.stringify(projectProviderError(error))).not.toContain(secret);
  });

  it("redacts media fields when their discriminator falls beyond the field cap", () => {
    const media = "QUJDRA==";
    const error: Record<string, unknown> = { data: media };
    for (let index = 0; index < 63; index += 1) {
      error[`field${index}`] = index;
    }
    error.type = "video";

    expect(JSON.stringify(projectProviderError(error))).not.toContain(media);
  });

  it.each([
    { name: "Buffer", bytes: Buffer.from([1, 2, 3]) },
    { name: "Uint8Array", bytes: new Uint8Array([4, 5, 6]) },
    { name: "ArrayBuffer", bytes: new Uint8Array([7, 8, 9]).buffer },
  ])("redacts $name media bytes without an installed host", ({ bytes }) => {
    const error = Object.assign(new Error("502 status code (no body)"), {
      status: 502,
      body: { type: "video", data: bytes },
    });

    const projected = projectProviderError(error);
    const serialized = JSON.stringify(projected);

    expect(projected.errorMessage).toContain("502:");
    expect(serialized).toContain("<redacted>");
    expect(serialized).not.toMatch(/"[0-9]+":(?:[0-9]+|\{)/u);
  });

  it.each([
    { name: "Buffer", body: Buffer.from([1, 2, 3]) },
    { name: "Uint8Array", body: new Uint8Array([4, 5, 6]) },
    { name: "ArrayBuffer", body: new Uint8Array([7, 8, 9]).buffer },
    {
      name: "DataView",
      body: new DataView(new Uint8Array([0, 10, 11, 12, 0]).buffer, 1, 3),
    },
  ])("redacts a bare $name response body by value", ({ body }) => {
    const projected = projectProviderError({ status: 500, body });
    const summary = '{"bytes":3,"redacted":"<redacted>"}';

    expect(projected.errorMessage).toBe(`500: ${summary}`);
    expect(projected.errorBody).toBe(summary);
    expect(JSON.stringify(projected)).not.toMatch(/"[0-9]+":(?:[0-9]+|\{)/u);
  });

  it("redacts credentials from terminal fields without an installed host", () => {
    const bearer = ["not", "a", "bearer", "credential"].join("-");
    const apiKey = ["not", "an", "api", "key"].join("-");
    const jwt = [
      "eyJub3QiLCJhIjoicmVhbCIsImp3dCI6dHJ1ZX0",
      "bm90LXJlYWwtc2lnbmF0dXJl",
      "bm90LXJlYWwtc2lnbmF0dXJl",
    ].join(".");
    const cookie = ["not", "a", "session", "cookie", "value"].join("-");
    const projected = projectProviderError({
      status: 400,
      body: {
        authorization: `Bearer ${bearer}`,
        apiKey,
        details: [`Bearer ${bearer}`, jwt, `session=${cookie}`],
      },
    });
    const serialized = JSON.stringify(projected);

    expect(serialized).not.toContain(bearer);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(jwt);
    expect(serialized).not.toContain(cookie);
    expect(serialized).toContain("Bearer <redacted>");
    expect(serialized).toContain("<redacted-jwt>");
    expect(serialized).toContain("session=<redacted>");
  });

  it.each([
    ["returns nullish", () => undefined],
    [
      "throws",
      () => {
        throw new Error("redactor failed");
      },
    ],
  ])("keeps the package-safe snapshot when host strengthening %s", (_name, redactor) => {
    const secret = "package-owned-fallback-secret";
    const previous = configureProviderErrorRedactor(redactor);
    try {
      const projected = projectProviderError({
        message: "provider failed",
        body: { apiKey: secret },
      });

      expect(projected.errorMessage).toBe("provider failed");
      expect(JSON.stringify(projected)).not.toContain(secret);
    } finally {
      configureProviderErrorRedactor(previous);
    }
  });

  it("preserves ordinary key-value diagnostics", () => {
    const value = "provider=openai api=openai-completions model=some-long-model-name";

    expect(projectProviderError(value).errorMessage).toBe(value);
  });

  it.each([
    "JSESSIONID=0123456789abcdef",
    "api_key=sk-0123456789012345",
    "https://host.test/path?api_key=abcdefghijklmnop&mode=test",
    'token="abcdefghijklmnop"',
  ])("redacts loose credential pair in %s", (value) => {
    expect(projectProviderError(value).errorMessage).not.toMatch(
      /0123456789abcdef|sk-0123456789012345|abcdefghijklmnop/u,
    );
  });

  it.each([
    "Cookie: JSESSIONID=0123456789abcdef; account=abcdefghijklmnop",
    "Set-Cookie: PHPSESSID=0123456789abcdef; Path=/; HttpOnly",
    "Cookie: sid=abc123",
    "Set-Cookie: auth=x:y",
  ])("redacts arbitrary credential names inside cookie headers", (header) => {
    expect(projectProviderError(header).errorMessage).toMatch(/^(?:Set-)?Cookie: <redacted>$/u);
  });

  it.each([
    "x-api-key: sk-0123456789012345",
    "api-key: 0123456789abcdef",
    "Authorization: ApiKey 0123456789abcdef",
    "Error: x-api-key: sk-0123456789012345",
    "headers: Authorization: ApiKey 0123456789abcdef",
    'headers: {"x-api-key":"sk-0123456789012345"}',
    "{'Authorization': 'ApiKey 0123456789abcdef'}",
  ])("redacts credential header %s", (header) => {
    expect(projectProviderError(header).errorMessage).not.toMatch(
      /sk-0123456789012345|0123456789abcdef/u,
    );
  });

  it("preserves ordinary colon-delimited diagnostics", () => {
    expect(projectProviderError("status: healthy").errorMessage).toBe("status: healthy");
  });

  it.each([
    ["credential", false],
    ["cookie", false],
    ["setCookie", false],
    ["privateKey", false],
    ["signingKey", false],
    ["secretAccessKey", false],
    ["AWS_SECRET_ACCESS_KEY", false],
    ["publicKey", true],
    ["accessKeyId", true],
  ])("classifies normalized credential field %s", (key, preserved) => {
    const value = `credential-value-for-${key}`;
    const serialized = JSON.stringify(
      projectProviderError({ status: 400, body: { [key]: value } }),
    );

    expect(serialized.includes(value)).toBe(preserved);
  });
});
