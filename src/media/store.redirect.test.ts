import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinnedLookup } from "../infra/net/ssrf.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { captureEnv } from "../test-utils/env.js";
import { saveMediaSource, setMediaStoreNetworkDepsForTest } from "./store.js";

const homeRootTracker = createSuiteTempRootTracker({
  prefix: "openclaw-home-redirect-",
});
const mockRequest = vi.fn();

function createMockHttpExchange() {
  const res = Object.assign(new PassThrough(), {
    statusCode: 0,
    headers: {} as Record<string, string>,
  });
  const req = {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (event === "error") {
        res.on("error", handler);
      }
      return req;
    },
    end: () => undefined,
    destroy: () => res.destroy(),
  } as const;
  return { req, res };
}

function mockRedirectExchange(params: { location?: string }) {
  const { req, res } = createMockHttpExchange();
  res.statusCode = 302;
  res.headers = params.location ? { location: params.location } : {};
  return {
    req,
    send(cb: (value: unknown) => void) {
      setImmediate(() => {
        cb(res as unknown);
        res.end();
      });
    },
  };
}

function mockSuccessfulTextExchange(params: { text: string; contentType: string }) {
  const { req, res } = createMockHttpExchange();
  res.statusCode = 200;
  res.headers = { "content-type": params.contentType };
  return {
    req,
    send(cb: (value: unknown) => void) {
      setImmediate(() => {
        cb(res as unknown);
        res.write(params.text);
        res.end();
      });
    },
  };
}

function getRequestHeaders(callIndex: number): Headers {
  const [, options] = mockRequest.mock.calls[callIndex] as [
    URL,
    { headers?: HeadersInit | Record<string, string> } | undefined,
  ];
  return new Headers(options?.headers);
}

async function expectRedirectSaveResult(params: {
  expectedText: string;
  expectedContentType: string;
  expectedExtension: string;
  headers?: Record<string, string>;
  assertRequests?: () => void;
}) {
  const saved = await saveMediaSource("https://example.com/start", params.headers);
  expect(mockRequest).toHaveBeenCalledTimes(2);
  params.assertRequests?.();
  expect(saved.contentType).toBe(params.expectedContentType);
  expect(path.extname(saved.path)).toBe(params.expectedExtension);
  expect(await fs.readFile(saved.path, "utf8")).toBe(params.expectedText);
  const stat = await fs.stat(saved.path);
  const expectedMode = process.platform === "win32" ? 0o666 : 0o644 & ~process.umask();
  expect(stat.mode & 0o777).toBe(expectedMode);
}

async function expectRedirectSaveFailure(expectedMessage: string) {
  await expect(saveMediaSource("https://example.com/start")).rejects.toThrow(expectedMessage);
  expect(mockRequest).toHaveBeenCalledTimes(1);
}

describe("media store redirects", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let home = "";

  beforeAll(async () => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    await homeRootTracker.setup();
    home = await homeRootTracker.make("state");
    process.env.OPENCLAW_STATE_DIR = home;
  });

  beforeEach(() => {
    mockRequest.mockClear();
    setMediaStoreNetworkDepsForTest({
      httpRequest: (...args) => mockRequest(...args),
      httpsRequest: (...args) => mockRequest(...args),
      resolvePinnedHostname: async (hostname) => ({
        hostname,
        addresses: ["93.184.216.34"],
        lookup: createPinnedLookup({ hostname, addresses: ["93.184.216.34"] }),
      }),
    });
  });

  afterAll(async () => {
    await homeRootTracker.cleanup();
    home = "";
    envSnapshot.restore();
    setMediaStoreNetworkDepsForTest();
    vi.clearAllMocks();
  });

  it("follows redirects and keeps detected mime/extension", async () => {
    let call = 0;
    mockRequest.mockImplementation((_url, _opts, cb) => {
      call += 1;
      if (call === 1) {
        const exchange = mockRedirectExchange({ location: "https://example.com/final" });
        exchange.send(cb);
        return exchange.req;
      }

      const exchange = mockSuccessfulTextExchange({
        text: "redirected",
        contentType: "text/plain",
      });
      exchange.send(cb);
      return exchange.req;
    });

    await expectRedirectSaveResult({
      expectedText: "redirected",
      expectedContentType: "text/plain",
      expectedExtension: ".txt",
    });
  });

  it("strips sensitive headers when a redirect crosses origins", async () => {
    let call = 0;
    mockRequest.mockImplementation((_url, _opts, cb) => {
      call += 1;
      if (call === 1) {
        const exchange = mockRedirectExchange({ location: "https://cdn.example.com/final" });
        exchange.send(cb);
        return exchange.req;
      }

      const exchange = mockSuccessfulTextExchange({
        text: "redirected",
        contentType: "text/plain",
      });
      exchange.send(cb);
      return exchange.req;
    });

    await saveMediaSource("https://example.com/start", {
      Authorization: "Bearer secret",
      Cookie: "session=abc",
      "X-Api-Key": "custom-secret",
      Accept: "text/plain",
      "User-Agent": "OpenClaw-Test/1.0",
    });

    expect(mockRequest).toHaveBeenCalledTimes(2);
    const secondHeaders = getRequestHeaders(1);
    expect(secondHeaders.get("authorization")).toBeNull();
    expect(secondHeaders.get("cookie")).toBeNull();
    expect(secondHeaders.get("x-api-key")).toBeNull();
    expect(secondHeaders.get("accept")).toBe("text/plain");
    expect(secondHeaders.get("user-agent")).toBe("OpenClaw-Test/1.0");
  });

  it("keeps headers when a redirect stays on the same origin", async () => {
    let call = 0;
    mockRequest.mockImplementation((_url, _opts, cb) => {
      call += 1;
      if (call === 1) {
        const exchange = mockRedirectExchange({ location: "/final" });
        exchange.send(cb);
        return exchange.req;
      }

      const exchange = mockSuccessfulTextExchange({
        text: "redirected",
        contentType: "text/plain",
      });
      exchange.send(cb);
      return exchange.req;
    });

    await saveMediaSource("https://example.com/start", {
      Authorization: "Bearer secret",
    });

    expect(getRequestHeaders(1).get("authorization")).toBe("Bearer secret");
  });

  it("fails when redirect response omits location header", async () => {
    mockRequest.mockImplementationOnce((_url, _opts, cb) => {
      const exchange = mockRedirectExchange({});
      exchange.send(cb);
      return exchange.req;
    });
    await expectRedirectSaveFailure("Redirect loop or missing Location header");
  });

  it("fails when redirect location is malformed", async () => {
    mockRequest.mockImplementationOnce((_url, _opts, cb) => {
      const exchange = mockRedirectExchange({ location: "http://[" });
      exchange.send(cb);
      return exchange.req;
    });
    await expectRedirectSaveFailure("Invalid redirect Location header");
  });
});
