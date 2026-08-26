import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { sanitizeDiagnosticPayload } from "./payload-redaction.js";

const MEDIA_DATA = "QUJDRA==";
const MEDIA_BYTES = [65, 66, 67, 68];
const MEDIA_SUMMARY = {
  bytes: 4,
  sha256: crypto.createHash("sha256").update(MEDIA_DATA).digest("hex"),
};
const BYTE_MEDIA_SUMMARY = {
  bytes: 4,
  sha256: crypto.createHash("sha256").update(new Uint8Array(MEDIA_BYTES)).digest("hex"),
};

describe("sanitizeDiagnosticPayload", () => {
  it("redacts typed media bytes without changing ordinary data and blob fields", () => {
    expect(
      sanitizeDiagnosticPayload({
        media: [
          { type: "audio", data: MEDIA_DATA },
          { mimeType: "video/mp4", blob: MEDIA_DATA },
          { type: "image", source: { data: MEDIA_DATA } },
          { type: "video", data: MEDIA_BYTES },
          { type: "video_frame", data: MEDIA_DATA },
          { type: "image_generation_call", result: MEDIA_DATA },
        ],
        wrappers: [
          { videos: [{ url: "https://media.invalid/private/path-token" }] },
          { audio: { data: MEDIA_DATA } },
          { video: { blob: MEDIA_DATA } },
          { video_frame: { data: MEDIA_DATA } },
          { videoFrame: { data: MEDIA_DATA } },
          { inputVideoFrame: { data: MEDIA_DATA } },
          { output_audio: { data: MEDIA_DATA } },
        ],
        ordinary: { audioCodec: { data: [...MEDIA_BYTES] }, data: MEDIA_BYTES, blob: MEDIA_DATA },
      }),
    ).toEqual({
      media: [
        { type: "audio", data: "<redacted>", ...MEDIA_SUMMARY },
        { mimeType: "video/mp4", blob: "<redacted>", ...MEDIA_SUMMARY },
        { type: "image", source: { data: "<redacted>", ...MEDIA_SUMMARY } },
        { type: "video", data: "<redacted>", ...BYTE_MEDIA_SUMMARY },
        { type: "video_frame", data: "<redacted>", ...MEDIA_SUMMARY },
        { type: "image_generation_call", result: "<redacted>", ...MEDIA_SUMMARY },
      ],
      wrappers: [
        { videos: "<redacted>" },
        { audio: { data: "<redacted>", ...MEDIA_SUMMARY } },
        { video: { blob: "<redacted>", ...MEDIA_SUMMARY } },
        { video_frame: { data: "<redacted>", ...MEDIA_SUMMARY } },
        { videoFrame: { data: "<redacted>", ...MEDIA_SUMMARY } },
        { inputVideoFrame: { data: "<redacted>", ...MEDIA_SUMMARY } },
        { output_audio: { data: "<redacted>", ...MEDIA_SUMMARY } },
      ],
      ordinary: { audioCodec: { data: [...MEDIA_BYTES] }, data: MEDIA_BYTES, blob: MEDIA_DATA },
    });
  });

  it.each([
    { name: "audio string", key: "audio", value: MEDIA_DATA, summary: MEDIA_SUMMARY },
    { name: "image numeric bytes", key: "image", value: MEDIA_BYTES, summary: BYTE_MEDIA_SUMMARY },
    {
      name: "video typed bytes",
      key: "video",
      value: new Uint8Array(MEDIA_BYTES),
      summary: BYTE_MEDIA_SUMMARY,
    },
  ])("redacts a direct $name field", ({ key, value, summary }) => {
    expect(sanitizeDiagnosticPayload({ [key]: value, audioCodec: MEDIA_DATA })).toEqual({
      [key]: "<redacted>",
      audioCodec: MEDIA_DATA,
      ...summary,
    });
  });

  it.each([
    ["string chunks", [MEDIA_DATA]],
    ["numeric chunks", [MEDIA_BYTES]],
  ])("redacts media arrays containing %s", (_name, videoFrames) => {
    expect(JSON.stringify(sanitizeDiagnosticPayload({ videoFrames }))).not.toMatch(
      /QUJDRA==|65,66,67,68/u,
    );
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
    const serialized = JSON.stringify(sanitizeDiagnosticPayload({ [key]: value }));

    expect(serialized.includes(value)).toBe(!redacted);
  });

  it.each([
    ["bytes", MEDIA_BYTES],
    ["buffer", MEDIA_DATA],
    ["uri", "https://media.invalid/private"],
    ["fileUri", "https://media.invalid/signed"],
  ])("redacts contextual media payload field %s", (key, value) => {
    expect(JSON.stringify(sanitizeDiagnosticPayload({ audio: { [key]: value } }))).not.toContain(
      JSON.stringify(value),
    );
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
    const serialized = JSON.stringify(sanitizeDiagnosticPayload({ [key]: value }));

    expect(serialized.includes(value)).toBe(preserved);
  });

  it.each([
    "Cookie: JSESSIONID=0123456789abcdef; account=abcdefghijklmnop",
    "Set-Cookie: PHPSESSID=0123456789abcdef; Path=/; HttpOnly",
    "Cookie: sid=abc123",
    "Set-Cookie: auth=x:y",
    "https://host.test/path?api_key=abcdefghijklmnop&mode=test",
    'token="abcdefghijklmnop"',
  ])("redacts credential pairs across text contexts", (header) => {
    const sanitized = sanitizeDiagnosticPayload(header);

    expect(sanitized).not.toMatch(/0123456789abcdef|abcdefghijklmnop/u);
    expect(sanitized).toContain("<redacted>");
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
    expect(sanitizeDiagnosticPayload(header)).not.toMatch(/sk-0123456789012345|0123456789abcdef/u);
  });

  it("preserves ordinary colon-delimited diagnostics", () => {
    expect(sanitizeDiagnosticPayload("status: healthy")).toBe("status: healthy");
  });

  it("redacts embedded and folded media data URLs without dropping surrounding text", () => {
    const value = `status before data:video/mp4;charset=utf-8;base64,\nQUJD\nRA== status after`;

    expect(sanitizeDiagnosticPayload(value)).toBe("status before <redacted> status after");
  });

  it.each([
    {
      name: "Google generated video",
      payload: {
        generatedVideos: [{ video: { videoBytes: MEDIA_DATA, mimeType: "video/mp4" } }],
      },
    },
    {
      name: "OpenRouter generated image",
      payload: { choices: [{ message: { content: [{ b64_json: MEDIA_DATA }] } }] },
    },
  ])("redacts provider byte fields from $name payloads", ({ payload }) => {
    expect(JSON.stringify(sanitizeDiagnosticPayload(payload))).not.toContain(MEDIA_DATA);
  });

  it.each([
    {
      name: "nested videoBytes",
      value: '{"generatedVideos":[{"video":{"videoBytes":"QUJDRA=="}}]}',
      leaked: MEDIA_DATA,
    },
    { name: "bare b64_json", value: '{"b64_json":"QUJDRA=="}', leaked: MEDIA_DATA },
    {
      name: "typed video data",
      value: '{"type":"video","data":"QUJDRA=="}',
      leaked: MEDIA_DATA,
    },
    {
      name: "prefixed image data",
      value: 'Error: {"b64_json":"QUJDRA=="}',
      leaked: MEDIA_DATA,
    },
    {
      name: "prefixed video data",
      value: 'Provider failed: {"type":"video","data":"QUJDRA=="}',
      leaked: MEDIA_DATA,
    },
    {
      name: "typed numeric video data",
      value: '{"type":"video","data":[65,66,67,68]}',
      leaked: "[65,66,67,68]",
    },
  ])("redacts $name from a JSON diagnostic string", ({ value, leaked }) => {
    expect(sanitizeDiagnosticPayload(value)).not.toContain(leaked);
  });

  it("preserves a harmless JSON diagnostic string byte-for-byte", () => {
    const value = ' {"message": "safe", "nested": [1, 2]}\n';

    expect(sanitizeDiagnosticPayload(value)).toBe(value);
  });

  it.each(["[GoogleGenerativeAI Error]: provider unavailable", "[429] rate limited: retry later"])(
    "preserves plain bracketed diagnostic text",
    (value) => {
      expect(sanitizeDiagnosticPayload(value)).toBe(value);
    },
  );

  it("fails closed for malformed JSON diagnostic strings", () => {
    const sanitized = sanitizeDiagnosticPayload('{"type":"video","data":"QUJDRA=="');

    expect(sanitized).not.toContain(MEDIA_DATA);
    expect(sanitized).toBe("[Malformed diagnostic JSON redacted]");
  });

  it("fails closed for hostile diagnostic properties", () => {
    const value = { type: "video", data: MEDIA_DATA };
    Object.defineProperty(value, "hostile", {
      enumerable: true,
      get: () => {
        throw new Error("getter failed");
      },
    });

    expect(JSON.stringify(sanitizeDiagnosticPayload(value))).not.toContain(MEDIA_DATA);
  });

  it.each([
    { name: "Buffer data", payload: { type: "video", data: Buffer.from([1, 2, 3]) } },
    {
      name: "Uint8Array blob",
      payload: { mimeType: "audio/wav", blob: new Uint8Array([4, 5, 6]) },
    },
  ])("redacts $name without expanding numeric byte maps", ({ payload }) => {
    const serialized = JSON.stringify(sanitizeDiagnosticPayload(payload));

    expect(serialized).toContain("<redacted>");
    expect(serialized).not.toMatch(/"[0-9]+":(?:[0-9]+|\{)/u);
  });

  it.each([
    { name: "Buffer", payload: Buffer.from([1, 2, 3]), bytes: [1, 2, 3] },
    { name: "Uint8Array", payload: new Uint8Array([4, 5, 6]), bytes: [4, 5, 6] },
    {
      name: "ArrayBuffer",
      payload: new Uint8Array([7, 8, 9]).buffer,
      bytes: [7, 8, 9],
    },
    {
      name: "DataView",
      payload: new DataView(new Uint8Array([0, 10, 11, 12, 0]).buffer, 1, 3),
      bytes: [10, 11, 12],
    },
  ])("redacts a bare $name by value", ({ payload, bytes }) => {
    const sanitized = sanitizeDiagnosticPayload(payload);

    expect(sanitized).toEqual({
      redacted: "<redacted>",
      bytes: bytes.length,
      sha256: crypto.createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/"[0-9]+":(?:[0-9]+|\{)/u);
  });
});
