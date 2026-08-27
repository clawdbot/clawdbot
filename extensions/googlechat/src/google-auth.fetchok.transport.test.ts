// Exercise Google auth requests through a real guarded HTTP transport.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loopback = vi.hoisted(() => ({
  baseUrl: "",
  contentLength: "",
  releases: [] as Array<{ bodyIsNull: boolean; bodyUsed: boolean }>,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (...args: Parameters<typeof actual.fetchWithSsrFGuard>) => {
      const [params] = args;
      const guarded = await actual.fetchWithSsrFGuard({
        ...params,
        policy: { allowPrivateNetwork: true },
        url: loopback.baseUrl,
      });
      return {
        ...guarded,
        release: async () => {
          loopback.releases.push({
            bodyIsNull: guarded.response.body === null,
            bodyUsed: guarded.response.bodyUsed,
          });
          await guarded.release();
        },
      };
    },
  };
});

const { getGoogleAuthTransport } = await import("./google-auth.runtime.js");

const RESPONSE_BODY = '{"access_token":"probe"}';

let server: Server;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-length": loopback.contentLength || String(RESPONSE_BODY.length),
      "content-type": "application/json",
    });
    res.end(RESPONSE_BODY);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  loopback.baseUrl = `http://127.0.0.1:${address.port}/token`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(() => {
  loopback.contentLength = "";
  loopback.releases = [];
});

describe("google auth guarded fetch", () => {
  it("cancels the unread body when the size guard rejects the response", async () => {
    loopback.contentLength = String(1024 * 1024 + 1);
    const transport = await getGoogleAuthTransport();

    await expect(transport.request({ url: loopback.baseUrl })).rejects.toThrow();

    expect(loopback.releases).toEqual([{ bodyIsNull: false, bodyUsed: true }]);
  });

  it("leaves a fully read response alone", async () => {
    const transport = await getGoogleAuthTransport();

    await transport.request({ url: loopback.baseUrl });

    expect(loopback.releases).toEqual([{ bodyIsNull: false, bodyUsed: true }]);
  });
});
