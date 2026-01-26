import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { downloadGoogleChatMedia } from "./api.js";

vi.mock("./auth.js", () => ({
  getGoogleChatAccessToken: vi.fn().mockResolvedValue("token"),
}));

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  config: {},
} as ResolvedGoogleChatAccount;

describe("downloadGoogleChatMedia", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects when content-length exceeds max bytes", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-length": "50", "content-type": "application/octet-stream" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      downloadGoogleChatMedia({ account, resourceName: "media/123", maxBytes: 10 }),
    ).rejects.toThrow(/max bytes/i);
  });

  it("rejects when streamed payload exceeds max bytes", async () => {
    const chunks = [new Uint8Array(6), new Uint8Array(6)];
    let index = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index++]);
        } else {
          controller.close();
        }
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      downloadGoogleChatMedia({ account, resourceName: "media/123", maxBytes: 10 }),
    ).rejects.toThrow(/max bytes/i);
  });
});
