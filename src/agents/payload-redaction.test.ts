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
        ],
        ordinary: { data: MEDIA_BYTES, blob: MEDIA_DATA },
      }),
    ).toEqual({
      media: [
        { type: "audio", data: "<redacted>", ...MEDIA_SUMMARY },
        { mimeType: "video/mp4", blob: "<redacted>", ...MEDIA_SUMMARY },
        { type: "image", source: { data: "<redacted>", ...MEDIA_SUMMARY } },
        { type: "video", data: "<redacted>", ...BYTE_MEDIA_SUMMARY },
      ],
      ordinary: { data: MEDIA_BYTES, blob: MEDIA_DATA },
    });
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
