import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { screencastParams } from "./test-support.js";
import { clearBrowserScreencastTokens, mintBrowserScreencastToken } from "./tokens.js";
import * as tokens from "./tokens.js";
import { handleBrowserScreencastUpgrade } from "./upgrade.js";

const mocks = vi.hoisted(() => ({ attach: vi.fn() }));
vi.mock("./session.js", () => ({ attachBrowserScreencastViewer: mocks.attach }));

describe("browser screencast WebSocket upgrade", () => {
  let server: Server;
  let url: string;
  let clients: WebSocket[];

  beforeEach(async () => {
    mocks.attach.mockReset();
    clients = [];
    server = createServer();
    server.on("upgrade", (req, socket, head) => {
      void handleBrowserScreencastUpgrade(req, socket, head);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/browser/screencast`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const client of clients) {
      client.terminate();
    }
    for (const [, viewer] of mocks.attach.mock.calls) {
      (viewer as WebSocket).terminate();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    clearBrowserScreencastTokens();
  });

  function connect(token: string, autoPong = true): WebSocket {
    const ws = new WebSocket(`${url}?token=${token}`, { autoPong });
    clients.push(ws);
    return ws;
  }

  async function rejected(token: string): Promise<number | undefined> {
    const ws = connect(token);
    return await new Promise((resolve) => {
      ws.once("open", () => resolve(undefined));
      ws.once("unexpected-response", (_request, response) => {
        response.resume();
        ws.on("error", () => {});
        ws.terminate();
        resolve(response.statusCode);
      });
    });
  }

  it("accepts a minted token once and rejects invalid or reused tokens with HTTP 401", async () => {
    expect(await rejected("invalid")).toBe(401);
    const params = screencastParams();
    const token = mintBrowserScreencastToken(params).token;
    const ws = connect(token);
    await once(ws, "open");
    expect(mocks.attach).toHaveBeenCalledWith(params, expect.any(WebSocket));
    expect(await rejected(token)).toBe(401);
  });

  it("rejects a fresh token whose requester aborts during consumption", async () => {
    const requester = new AbortController();
    const token = mintBrowserScreencastToken(
      screencastParams({ requesterSignal: requester.signal }),
    );
    const consume = tokens.consumeBrowserScreencastToken;
    vi.spyOn(tokens, "consumeBrowserScreencastToken").mockImplementationOnce((value) => {
      const params = consume(value);
      requester.abort();
      return params;
    });
    expect(await rejected(token.token)).toBe(401);
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it("rejects and consumes a minted ticket after requester invalidation before its close handshake finishes", async () => {
    const requester = { invalidated: false, signal: new AbortController().signal };
    const token = mintBrowserScreencastToken(
      screencastParams({
        requesterSignal: requester.signal,
        isRequesterCurrent: () => !requester.invalidated,
      }),
    );
    requester.invalidated = true;
    expect(requester.signal.aborted).toBe(false);
    expect(await rejected(token.token)).toBe(401);
    requester.invalidated = false;
    expect(await rejected(token.token)).toBe(401);
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it("rejects binary input on the view-only socket", async () => {
    const ws = connect(mintBrowserScreencastToken(screencastParams()).token);
    await once(ws, "open");
    const closed = once(ws, "close");
    ws.send(Buffer.from([1]));
    expect(await closed).toEqual([1003, Buffer.from("view_only")]);
  });

  it("pings viewers and terminates a missed pong", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const ws = connect(mintBrowserScreencastToken(screencastParams()).token, false);
    await once(ws, "open");
    const ping = once(ws, "ping");
    await vi.advanceTimersByTimeAsync(25_000);
    await ping;
    const closed = once(ws, "close");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await closed).toEqual([1006, Buffer.alloc(0)]);
  });
});
