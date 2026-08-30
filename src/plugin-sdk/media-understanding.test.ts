import { describe, expect, it, vi } from "vitest";

vi.mock("../media-understanding/shared.js", () => {
  throw new Error("Media transport must stay cold while importing the provider SDK");
});

describe("media-understanding provider SDK", () => {
  it("keeps imports and synchronous video helpers free of media transport", async () => {
    const media = await import("./media-understanding.js");

    expect(media.resolveMediaUnderstandingString("  ", "fallback")).toBe("fallback");
    expect(
      media.coerceOpenAiCompatibleVideoText({
        choices: [{ message: { content: [{ text: " first " }, { text: "second" }] } }],
      }),
    ).toBe("first\nsecond");
    expect(
      media.buildOpenAiCompatibleVideoRequestBody({
        model: "fixture-video",
        prompt: "Describe the clip.",
        mime: "video/mp4",
        buffer: Buffer.from("video"),
      }),
    ).toEqual({
      model: "fixture-video",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe the clip." },
            { type: "video_url", video_url: { url: "data:video/mp4;base64,dmlkZW8=" } },
          ],
        },
      ],
    });
  });
});
