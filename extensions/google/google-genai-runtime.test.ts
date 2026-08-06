// Google tests cover GenAI SDK runtime wiring.
import { afterEach, describe, expect, it, vi } from "vitest";

const { googleGenAIMock } = vi.hoisted(() => ({
  googleGenAIMock: vi.fn(function GoogleGenAI(this: { options?: unknown }, options: unknown) {
    this.options = options;
  }),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: googleGenAIMock,
}));

import { createGoogleGenAI } from "./google-genai-runtime.js";

afterEach(() => {
  googleGenAIMock.mockClear();
});

describe("createGoogleGenAI", () => {
  it("adds the documented Gemini API partner client header", () => {
    createGoogleGenAI({
      apiKey: "google-key",
      httpOptions: {
        headers: {
          "X-Test": "value",
        },
      },
    });

    const options = googleGenAIMock.mock.calls[0]?.[0] as {
      httpOptions?: { headers?: Record<string, string> };
    };
    expect(options.httpOptions?.headers).toMatchObject({
      "X-Test": "value",
    });
    expect(options.httpOptions?.headers?.["x-goog-api-client"]).toMatch(/^openclaw\//u);
  });
});
