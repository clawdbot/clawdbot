// Feishu tests cover app registration plugin behavior.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginAppRegistration,
  type FeishuAppRegistrationFetch,
  pollAppRegistration,
  printQrCode,
} from "./app-registration.js";

const FEISHU_JSON_MAX_BYTES = 16 * 1024 * 1024;

const { renderQrTerminalMock } = vi.hoisted(() => ({
  renderQrTerminalMock: vi.fn(async () => "terminal-qr"),
}));

vi.mock("./qr-terminal.js", () => ({
  renderQrTerminal: renderQrTerminalMock,
}));

type LocalServer = {
  port: number;
  stop: () => Promise<void>;
};

type DispatcherInit = RequestInit & { dispatcher?: unknown };
type RegistrationFetchOptions = {
  fetchImpl: FeishuAppRegistrationFetch;
  lookupFn: LookupFn;
};

const HERMETIC_PUBLIC_LOOKUP_ADDRESS = "93.184.216.34";

const hermeticPublicLookup: LookupFn = (async (_hostname: string, _options?: unknown) => ({
  address: HERMETIC_PUBLIC_LOOKUP_ADDRESS,
  family: 4,
})) as LookupFn;

async function startLocalServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<LocalServer> {
  return await new Promise<LocalServer>((resolve, reject) => {
    const server = createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("local test server did not expose a TCP port"));
        return;
      }
      resolve({
        port: addr.port,
        stop: async () =>
          await new Promise<void>((innerResolve, innerReject) => {
            server.close((err) => (err ? innerReject(err) : innerResolve()));
          }),
      });
    });
  });
}

function stripDispatcher(init: RequestInit | undefined): RequestInit | undefined {
  if (!init || !("dispatcher" in init)) {
    return init;
  }
  const { dispatcher: _dispatcher, ...rest } = init as DispatcherInit;
  return rest;
}

function createLocalRedirectFetch(port: number): FeishuAppRegistrationFetch {
  const realFetch = globalThis.fetch.bind(globalThis);
  return withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "accounts.feishu.cn" || url.hostname === "accounts.larksuite.com") {
      const loopback = new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${port}`);
      return await realFetch(loopback, stripDispatcher(init));
    }
    return await realFetch(input, init);
  });
}

async function withRegistrationServer<T>(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (options: RegistrationFetchOptions) => Promise<T>,
): Promise<T> {
  const server = await startLocalServer(handler);
  try {
    return await run({
      fetchImpl: createLocalRedirectFetch(server.port),
      lookupFn: hermeticPublicLookup,
    });
  } finally {
    await server.stop();
  }
}

function writeJson(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function writeOversizedJson(
  res: ServerResponse,
  totalBytes: number,
): { bytesPulled: () => number; canceled: () => boolean } {
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  let bytesPulled = 0;
  let canceled = false;
  let ended = false;
  res.writeHead(200, { "content-type": "application/json" });
  res.on("close", () => {
    if (!ended && bytesPulled < totalBytes) {
      canceled = true;
    }
  });
  const prefix = Buffer.from('{"device_code":"dev","padding":"');
  bytesPulled += prefix.byteLength;
  res.write(prefix);
  const sendChunk = () => {
    if (bytesPulled >= totalBytes) {
      if (!res.destroyed) {
        ended = true;
        res.end('"}');
      }
      return;
    }
    const remaining = totalBytes - bytesPulled;
    const size = Math.min(chunk.byteLength, remaining);
    bytesPulled += size;
    const ok = res.write(chunk.subarray(0, size));
    if (ok) {
      setImmediate(sendChunk);
      return;
    }
    res.once("drain", sendChunk);
  };
  setImmediate(sendChunk);
  return {
    bytesPulled: () => bytesPulled,
    canceled: () => canceled || (!ended && bytesPulled < totalBytes),
  };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
  }
  return body;
}

async function readRegistrationAction(req: IncomingMessage): Promise<string> {
  const body = await readRequestBody(req);
  return new URLSearchParams(body).get("action") ?? "";
}

function beginRegistrationPayload(
  overrides?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    device_code: "device-code",
    verification_uri_complete: "https://accounts.feishu.cn/verify?x=1",
    user_code: "user-code",
    interval: 5,
    expire_in: 300,
    ...overrides,
  };
}

function beginRegistrationWithServer<T>(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (options: RegistrationFetchOptions) => Promise<T>,
): Promise<T> {
  return withRegistrationServer(handler, run);
}

function beginRegistrationJson<T>(
  payload: Record<string, unknown>,
  run: (options: RegistrationFetchOptions) => Promise<T>,
): Promise<T> {
  return beginRegistrationWithServer((req, res) => {
    void readRegistrationAction(req).then((action) => {
      if (action !== "begin") {
        res.writeHead(400);
        res.end("unexpected action");
        return;
      }
      writeJson(res, payload);
    });
  }, run);
}

describe("Feishu app registration", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    renderQrTerminalMock.mockClear();
  });

  it("defaults unsafe begin polling lifetimes from provider responses", async () => {
    await beginRegistrationJson(
      beginRegistrationPayload({
        interval: Number.POSITIVE_INFINITY,
        expire_in: Number.POSITIVE_INFINITY,
      }),
      async (options) => {
        await expect(beginAppRegistration("feishu", options)).resolves.toMatchObject({
          deviceCode: "device-code",
          userCode: "user-code",
          interval: 5,
          expireIn: 600,
        });
      },
    );
  });

  it("clamps unsafe poll sleeps from provider intervals", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fetchImpl = withFetchPreconnect(
      vi.fn(async () => {
        throw new Error("transient");
      }),
    ) as FeishuAppRegistrationFetch;

    const poll = pollAppRegistration({
      deviceCode: "device-code",
      interval: 10_000_000,
      expireIn: 10_000_000,
      fetchImpl,
      lookupFn: hermeticPublicLookup,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);

    await vi.runOnlyPendingTimersAsync();
    await expect(poll).resolves.toEqual({ status: "timeout" });
  });

  it("prints scan-to-create QR codes with compact terminal rendering", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await printQrCode("https://accounts.feishu.cn/verify?device_code=long-device-code");

    expect(renderQrTerminalMock).toHaveBeenCalledWith(
      "https://accounts.feishu.cn/verify?device_code=long-device-code",
      { small: true },
    );
    expect(writeSpy).toHaveBeenCalledWith("terminal-qr\n");
  });

  it("times out registration POSTs when accounts never return headers", async () => {
    await withRegistrationServer(
      // Accept TCP but never write headers — idle body timers never start.
      (_req, _res) => {},
      async (options) => {
        const started = Date.now();
        const outcome = await beginAppRegistration("feishu", {
          ...options,
          // Keep the real guarded-fetch path while shortening its production deadline.
          timeoutMs: 80,
        }).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        const elapsedMs = Date.now() - started;
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.error).toMatchObject({
            name: "TimeoutError",
            message: "request timed out",
          });
        }
        expect(elapsedMs).toBeGreaterThanOrEqual(60);
        expect(elapsedMs).toBeLessThan(2_000);
        console.log(
          `[feishu fetchFeishuJson hang proof] timed_out=${!outcome.ok} name=${
            outcome.ok ? "n/a" : (outcome.error as Error).name
          } elapsed_ms=${elapsedMs}`,
        );
      },
    );
  });

  // over-cap: body > 16 MiB, no Content-Length. The bounded reader cancels
  // through the real SSRF guard and rejects before full buffering.
  it("rejects Feishu API responses that exceed the 16 MiB JSON body cap", async () => {
    let streamState:
      | {
          bytesPulled: () => number;
          canceled: () => boolean;
        }
      | undefined;
    await beginRegistrationWithServer(
      (_req, res) => {
        streamState = writeOversizedJson(res, FEISHU_JSON_MAX_BYTES * 2);
      },
      async (options) => {
        await expect(beginAppRegistration("feishu", options)).rejects.toThrow(
          /feishu\.api: JSON response exceeds \d+ bytes/,
        );
      },
    );

    expect(streamState?.canceled()).toBe(true);
    expect(streamState?.bytesPulled()).toBeLessThan(FEISHU_JSON_MAX_BYTES * 2);
    console.log(
      `[feishu fetchFeishuJson bound proof] over-cap: bytes_pulled=${streamState?.bytesPulled()} cap=${FEISHU_JSON_MAX_BYTES} canceled=${streamState?.canceled()}`,
    );
  });

  // under-cap: a normal-sized valid JSON response is parsed and returned correctly.
  it("parses under-cap Feishu API JSON responses and returns the typed payload", async () => {
    const payload = {
      device_code: "dev-code-123",
      verification_uri_complete: "https://accounts.feishu.cn/verify?x=1",
      user_code: "UC-456",
      interval: 5,
      expire_in: 300,
    };

    await beginRegistrationJson(payload, async (options) => {
      const result = await beginAppRegistration("feishu", options);
      expect(result).toMatchObject({
        deviceCode: "dev-code-123",
        userCode: "UC-456",
        interval: 5,
        expireIn: 300,
      });
      console.log(
        `[feishu fetchFeishuJson bound proof] under-cap: returned=${JSON.stringify(result)}`,
      );
    });
  });

  it("sends bound reads through the real SSRF guard before local socket redirect", async () => {
    const fetchCalls: string[] = [];
    await beginRegistrationJson(beginRegistrationPayload(), async (options) => {
      const recordingFetch: FeishuAppRegistrationFetch = withFetchPreconnect(
        async (input, init) => {
          fetchCalls.push(input instanceof Request ? input.url : input.toString());
          return await options.fetchImpl(input, init);
        },
      );

      await expect(
        beginAppRegistration("feishu", { ...options, fetchImpl: recordingFetch }),
      ).resolves.toMatchObject({
        deviceCode: "device-code",
        userCode: "user-code",
      });
    });

    expect(fetchCalls).toEqual(["https://accounts.feishu.cn/oauth/v1/app/registration"]);
    console.log(
      `[feishu fetchFeishuJson bound proof] real-ssrf-guard: guarded_url=${fetchCalls[0]} socket=127.0.0.1`,
    );
  });

  it("wraps malformed Feishu API JSON with a feishu.api labelled error", async () => {
    await beginRegistrationWithServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("not-valid-json{{");
      },
      async (options) => {
        await expect(beginAppRegistration("feishu", options)).rejects.toThrow(
          /feishu\.api: malformed JSON response/,
        );
      },
    );
  });
});

describe("feishu bound reads — local HTTP server", () => {
  it("rejects oversized response before fully buffering the response (OOM guard)", async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const totalChunks = 64;
    let chunksWritten = 0;

    const srv = await startLocalServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      let sent = 0;
      const sendChunk = () => {
        if (sent >= totalChunks) {
          res.end();
          return;
        }
        sent += 1;
        chunksWritten += 1;
        const ok = res.write(chunk);
        if (ok) {
          setImmediate(sendChunk);
          return;
        }
        res.once("drain", sendChunk);
      };
      sendChunk();
    });

    try {
      const response = await fetch(`http://127.0.0.1:${srv.port}/`);
      // Mutation-control: bare `response.json()` would buffer all 20 MiB.
      await expect(readProviderJsonResponse(response, "feishu.bound-proof")).rejects.toThrow(
        /JSON response exceeds/,
      );
      expect(chunksWritten).toBeLessThan(totalChunks);
      console.log(`[bound-proof] canceled at ${chunksWritten}/${totalChunks} chunks`);
    } finally {
      await srv.stop();
    }
  });

  it("parses well-formed JSON response under the cap", async () => {
    const payload = { code: 0, data: { app_id: "cli_test" } };
    const srv = await startLocalServer((_req, res) => {
      writeJson(res, payload);
    });
    try {
      const response = await fetch(`http://127.0.0.1:${srv.port}/`);
      const result = await readProviderJsonResponse<typeof payload>(response, "feishu.bound-proof");
      expect(result).toEqual(payload);
    } finally {
      await srv.stop();
    }
  });
});
