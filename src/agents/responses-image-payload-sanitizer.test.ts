import { sanitizeResponsesImagePayload } from "@openclaw/ai/transports";
// Verifies Responses image payloads are canonicalized or replaced before send.
import { describe, expect, it } from "vitest";

const PNG_1X1 =
  // Valid JPEG-labeled data is sniffed as PNG and normalized to the real MIME type.
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
const HEIC_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
]).toString("base64");

describe("Responses image payload sanitizer", () => {
  it("replaces malformed input_image data URLs before sending Responses payloads", () => {
    const sanitized = sanitizeResponsesImagePayload({
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [{ type: "input_image", image_url: "data:image/jpeg;base64,not base64!" }],
        },
      ],
    });

    expect(sanitized.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          {
            type: "input_text",
            text: "[omitted image payload: invalid inline image data]",
          },
        ],
      },
    ]);
  });

  it("canonicalizes valid inline image payloads and keeps URL image references", () => {
    const sanitized = sanitizeResponsesImagePayload({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: `data:image/jpeg;base64,\n${PNG_1X1}` },
            { type: "input_image", image_url: "https://example.test/image.png" },
          ],
        },
      ],
    });

    expect(sanitized.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image_url: `data:image/png;base64,${PNG_1X1}` },
          { type: "input_image", image_url: "https://example.test/image.png" },
        ],
      },
    ]);
  });

  it("replaces HEIC inline image data URLs before Responses transport", () => {
    const sanitized = sanitizeResponsesImagePayload({
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: `data:image/heic;base64,${HEIC_HEADER}` }],
        },
      ],
    });

    expect(sanitized.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "[omitted image payload: invalid inline image data]",
          },
        ],
      },
    ]);
  });
});
