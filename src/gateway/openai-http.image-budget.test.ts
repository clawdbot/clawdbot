import { beforeEach, describe, expect, it, vi } from "vitest";

const extractImageContentFromSourceMock = vi.fn();

vi.mock("../media/input-files.js", async () => {
  const actual =
    await vi.importActual<typeof import("../media/input-files.js")>("../media/input-files.js");
  return {
    ...actual,
    extractImageContentFromSource: (...args: unknown[]) =>
      extractImageContentFromSourceMock(...args),
  };
});

import { testOnlyOpenAiHttp } from "./openai-http.js";

describe("openai image budget accounting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts normalized base64 image bytes against maxTotalImageBytes", async () => {
    extractImageContentFromSourceMock.mockResolvedValueOnce({
      type: "image",
      data: Buffer.alloc(10, 1).toString("base64"),
      mimeType: "image/jpeg",
    });

    const limits = testOnlyOpenAiHttp.resolveOpenAiChatCompletionsLimits({
      maxTotalImageBytes: 5,
    });

    await expect(
      testOnlyOpenAiHttp.resolveImagesForRequest(
        {
          urls: ["data:image/heic;base64,QUJD"],
        },
        limits,
      ),
    ).rejects.toThrow(/Total image payload too large/);
  });

  it("does not double-count unchanged base64 image payloads", async () => {
    extractImageContentFromSourceMock.mockResolvedValueOnce({
      type: "image",
      data: "QUJDRA==",
      mimeType: "image/jpeg",
    });

    const limits = testOnlyOpenAiHttp.resolveOpenAiChatCompletionsLimits({
      maxTotalImageBytes: 4,
    });

    await expect(
      testOnlyOpenAiHttp.resolveImagesForRequest(
        {
          urls: ["data:image/jpeg;base64,QUJDRA=="],
        },
        limits,
      ),
    ).resolves.toEqual([
      {
        type: "image",
        data: "QUJDRA==",
        mimeType: "image/jpeg",
      },
    ]);
  });
});
