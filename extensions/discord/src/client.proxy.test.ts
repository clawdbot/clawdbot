import http from "node:http";
import { fetch as undiciFetch } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { createDiscordRestClient } from "./client.js";
import { createDiscordRequestClient } from "./proxy-request-client.js";

const makeProxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/infra-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/infra-runtime")>(
    "openclaw/plugin-sdk/infra-runtime",
  );
  makeProxyFetchMock.mockImplementation((proxyUrl: string) => {
    if (proxyUrl === "bad-proxy") {
      throw new Error("bad proxy");
    }
    return actual.makeProxyFetch(proxyUrl);
  });
  return {
    ...actual,
    makeProxyFetch: makeProxyFetchMock,
  };
});

describe("createDiscordRestClient proxy support", () => {
  beforeEach(() => {
    makeProxyFetchMock.mockClear();
  });

  it("injects a custom fetch into RequestClient when a Discord proxy is configured", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://127.0.0.1:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      customFetch?: typeof fetch;
      options?: { fetch?: typeof fetch };
    };

    expect(requestClient.options?.fetch).toEqual(expect.any(Function));
    expect(requestClient.customFetch).toBe(requestClient.options?.fetch);
  });

  it("does not inject fetch when no proxy is configured", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(requestClient.options?.fetch).toBeUndefined();
  });

  it("falls back to direct fetch when the Discord proxy URL is invalid", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "bad-proxy",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).not.toHaveBeenCalledWith("bad-proxy");
    expect(requestClient.options?.fetch).toBeUndefined();
  });

  it("falls back to direct fetch when the Discord proxy URL is remote", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://proxy.test:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).not.toHaveBeenCalledWith("http://proxy.test:8080");
    expect(requestClient.options?.fetch).toBeUndefined();
  });

  it("accepts IPv6 loopback Discord proxy URLs", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://[::1]:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://[::1]:8080");
    expect(requestClient.options?.fetch).toEqual(expect.any(Function));
  });

  it("serializes multipart media with undici-compatible FormData for proxy fetches", async () => {
    const received = await new Promise<{
      contentType: string | undefined;
      body: string;
    }>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("error", reject);
        req.on("end", () => {
          resolve({
            contentType: req.headers["content-type"],
            body: Buffer.concat(chunks).toString("utf8"),
          });
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ id: "message-id", channel_id: "channel-id" }));
          server.close();
        });
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("failed to bind test server"));
          server.close();
          return;
        }
        const rest = createDiscordRequestClient("test-token", {
          baseUrl: `http://127.0.0.1:${address.port}`,
          fetch: undiciFetch as unknown as typeof fetch,
          queueRequests: false,
        });
        void rest
          .post("/channels/123/messages", {
            body: {
              content: "with image",
              files: [{ data: Buffer.from("png-data"), name: "image.png" }],
            },
          })
          .catch((err: unknown) => {
            reject(err);
            server.close();
          });
      });
    });

    expect(received.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(received.body).toContain('name="files[0]"; filename="image.png"');
    expect(received.body).toContain('name="payload_json"');
    expect(received.body).toContain('"attachments":[{"id":0,"filename":"image.png"}]');
  });
});
