import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
// Zalo tests cover outbound media plugin behavior.
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";

const loadWebMediaMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/web-media", () => {
  return {
    loadWebMedia: (...args: unknown[]) => loadWebMediaMock(...args),
  };
});

import {
  clearHostedZaloMediaForTest,
  prepareHostedZaloMediaUrl,
  resolveHostedZaloMediaRoutePrefix,
  tryHandleHostedZaloMediaRequest,
} from "./outbound-media.js";
import { setZaloRuntime } from "./runtime.js";

function createMockResponse() {
  const headers = new Map<string, string>();
  return {
    headers,
    res: {
      statusCode: 200,
      setHeader(name: string, value: string) {
        headers.set(name, value);
      },
      end: vi.fn(),
    },
  };
}

function installZaloRuntimeForTest(): void {
  setZaloRuntime({
    state: {
      openKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("zalo", options),
    },
  } as unknown as PluginRuntime);
}

describe("zalo outbound hosted media", () => {
  beforeEach(async () => {
    resetPluginStateStoreForTests();
    installZaloRuntimeForTest();
    await clearHostedZaloMediaForTest();
    loadWebMediaMock.mockReset();
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      kind: "image",
      contentType: "image/png",
      fileName: "photo.png",
    });
  });

  it("loads outbound media under OpenClaw control and returns a hosted URL", async () => {
    const hostedUrl = await prepareHostedZaloMediaUrl({
      mediaUrl: "https://example.com/photo.png",
      webhookUrl: "https://gateway.example.com/zalo-webhook",
      maxBytes: 1024,
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "https://example.com/photo.png",
      expect.objectContaining({ maxBytes: 1024 }),
    );
    expect(hostedUrl).toMatch(
      /^https:\/\/gateway\.example\.com\/zalo-webhook\/media\/[a-f0-9]+\?token=[a-f0-9]+$/,
    );
  });

  it("passes proxy-aware fetch options into hosted media downloads", async () => {
    await prepareHostedZaloMediaUrl({
      mediaUrl: "https://example.com/photo.png",
      webhookUrl: "https://gateway.example.com/zalo-webhook",
      maxBytes: 1024,
      proxyUrl: "http://proxy.example:8080",
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "https://example.com/photo.png",
      expect.objectContaining({ maxBytes: 1024, proxyUrl: "http://proxy.example:8080" }),
    );
  });

  it("persists hosted media in SQLite plugin state instead of temp sidecars", async () => {
    const hostedUrl = await prepareHostedZaloMediaUrl({
      mediaUrl: "https://example.com/photo.png",
      webhookUrl: "https://gateway.example.com/zalo-webhook",
      maxBytes: 1024,
    });

    const { pathname } = new URL(hostedUrl);
    const id = pathname.split("/").pop();
    if (!id) {
      throw new Error("expected hosted Zalo media id");
    }
    expect(id).toHaveLength(24);
    expect(/^[0-9a-f]+$/.test(id)).toBe(true);

    const metaStore = createPluginStateKeyedStoreForTests("zalo", {
      namespace: "hosted-outbound-media",
      maxEntries: 80,
    });
    const chunkStore = createPluginStateKeyedStoreForTests("zalo", {
      namespace: "hosted-outbound-media-chunks",
      maxEntries: 16_384,
    });

    const metaEntries = await metaStore.entries();
    expect(metaEntries).toHaveLength(1);
    expect(metaEntries[0]?.value).toMatchObject({
      id,
      routePath: "/zalo-webhook/media/",
      contentType: "image/png",
      byteLength: Buffer.byteLength("image-bytes"),
    });
    expect(await chunkStore.entries()).toHaveLength(1);
  });

  it("preserves the root webhook path when deriving the hosted media route", () => {
    expect(
      resolveHostedZaloMediaRoutePrefix({
        webhookUrl: "https://gateway.example.com/",
      }),
    ).toBe("/media");
  });

  it("serves hosted media once when the route token matches", async () => {
    const hostedUrl = await prepareHostedZaloMediaUrl({
      mediaUrl: "https://example.com/photo.png",
      webhookUrl: "https://gateway.example.com/zalo-webhook",
      maxBytes: 1024,
    });
    const { pathname, search } = new URL(hostedUrl);
    const response = createMockResponse();

    const handled = await tryHandleHostedZaloMediaRequest(
      {
        method: "GET",
        url: `${pathname}${search}`,
      } as never,
      response.res as never,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.res.end).toHaveBeenCalledWith(Buffer.from("image-bytes"));

    const secondResponse = createMockResponse();
    const handledAgain = await tryHandleHostedZaloMediaRequest(
      {
        method: "GET",
        url: `${pathname}${search}`,
      } as never,
      secondResponse.res as never,
    );

    expect(handledAgain).toBe(true);
    expect(secondResponse.res.statusCode).toBe(404);
  });

  it("rejects hosted media preparation when the expiry would exceed a valid Date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    try {
      await expect(
        prepareHostedZaloMediaUrl({
          mediaUrl: "https://example.com/photo.png",
          webhookUrl: "https://gateway.example.com/zalo-webhook",
          maxBytes: 1024,
        }),
      ).rejects.toThrow(/expiry/);

      expect(loadWebMediaMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not serve hosted media when the current clock is invalid", async () => {
    const hostedUrl = await prepareHostedZaloMediaUrl({
      mediaUrl: "https://example.com/photo.png",
      webhookUrl: "https://gateway.example.com/zalo-webhook",
      maxBytes: 1024,
    });
    const { pathname, search } = new URL(hostedUrl);
    const response = createMockResponse();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      const handled = await tryHandleHostedZaloMediaRequest(
        {
          method: "GET",
          url: `${pathname}${search}`,
        } as never,
        response.res as never,
      );

      expect(handled).toBe(true);
      expect(response.res.statusCode).toBe(410);
      expect(response.res.end).toHaveBeenCalledWith("Expired");
    } finally {
      dateNow.mockRestore();
    }
  });

  it("rejects hosted media requests with the wrong token", async () => {
    const hostedUrl = await prepareHostedZaloMediaUrl({
      mediaUrl: "https://example.com/photo.png",
      webhookUrl: "https://gateway.example.com/custom/zalo",
      webhookPath: "/custom/zalo-hook",
      maxBytes: 1024,
    });
    const pathname = new URL(hostedUrl).pathname;
    const response = createMockResponse();

    const handled = await tryHandleHostedZaloMediaRequest(
      {
        method: "GET",
        url: `${pathname}?token=wrong`,
      } as never,
      response.res as never,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(401);
    expect(response.res.end).toHaveBeenCalledWith("Unauthorized");
  });

  it("rejects malformed hosted media ids before touching disk", async () => {
    const response = createMockResponse();

    const handled = await tryHandleHostedZaloMediaRequest(
      {
        method: "GET",
        url: "/zalo-webhook/media/not-a-valid-hex-id?token=wrong",
      } as never,
      response.res as never,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(404);
    expect(response.res.end).toHaveBeenCalledWith("Not Found");
  });
});
