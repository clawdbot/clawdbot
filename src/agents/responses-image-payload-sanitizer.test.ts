import { describe, expect, it } from "vitest";
import { sanitizeResponsesImagePayload } from "./responses-image-payload-sanitizer.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

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
});
