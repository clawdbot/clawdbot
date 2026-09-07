// Slack tests cover provider ingress startup cleanup behavior.
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSlackHttpRequest } from "../http/registry.js";
import { getSlackTestState, resetSlackTestState } from "../monitor.test-helpers.js";

const ingressStartMock = vi.hoisted(() => vi.fn());
const ingressStopMock = vi.hoisted(() => vi.fn());

vi.mock("./ingress.js", () => ({
  createSlackDurableIngress: () => ({
    wrapReceiver: (receiver: unknown) => receiver,
    acceptRelayEvent: vi.fn(),
    attachRelayDispatch: vi.fn(),
    start: ingressStartMock,
    stop: ingressStopMock,
    waitForIdle: vi.fn(),
  }),
}));

const { monitorSlackProvider } = await import("./provider.js");

beforeEach(() => {
  resetSlackTestState();
  ingressStartMock.mockReset();
  ingressStopMock.mockReset().mockResolvedValue(undefined);
});

afterAll(() => {
  vi.doUnmock("./ingress.js");
  vi.resetModules();
});

describe("Slack ingress startup cleanup", () => {
  it("rejects an oversized body before Bolt's void listener reads asynchronously", async () => {
    const state = getSlackTestState();
    state.httpRequestListenerMock.mockImplementation((reqValue, resValue) => {
      const req = reqValue as IncomingMessage;
      const res = resValue as ServerResponse;
      void (async () => {
        for await (const chunk of req) {
          // Bolt buffers the full body before signature verification.
          void chunk;
        }
        if (!res.headersSent) {
          res.statusCode = 401;
          res.end();
        }
      })();
    });
    state.config = {
      ...state.config,
      channels: {
        slack: {
          mode: "http",
          signingSecret: "test-signing-secret",
          dmPolicy: "open",
          allowFrom: ["*"],
          groupPolicy: "open",
        },
      },
    };
    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      abortSignal: controller.signal,
      config: state.config,
    });
    let server: Server | undefined;
    let clientRequest: ReturnType<typeof request> | undefined;

    try {
      await vi.waitFor(() => expect(ingressStartMock).toHaveBeenCalledTimes(1));
      let acceptRequest: (() => void) | undefined;
      const accepted = new Promise<void>((resolve) => {
        acceptRequest = resolve;
      });
      server = createServer((req, res) => {
        acceptRequest?.();
        void handleSlackHttpRequest(req, res);
      });
      await new Promise<void>((resolve) => {
        server!.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not expose a TCP port");
      }
      clientRequest = request({
        host: "127.0.0.1",
        port: address.port,
        path: "/slack/events",
        method: "POST",
        headers: { "transfer-encoding": "chunked" },
      });
      clientRequest.on("error", () => {});
      const response = new Promise<{ statusCode: number | undefined; body: string }>(
        (resolve, reject) => {
          clientRequest!.once("response", (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              body += chunk;
            });
            res.once("end", () => resolve({ statusCode: res.statusCode, body }));
          });
          clientRequest!.once("error", reject);
        },
      );
      clientRequest.flushHeaders();

      await accepted;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      clientRequest.write(Buffer.alloc(768 * 1024, 0x61));
      clientRequest.end(Buffer.alloc(768 * 1024, 0x62));

      await expect(response).resolves.toEqual({
        statusCode: 413,
        body: "Payload too large",
      });
    } finally {
      clientRequest?.destroy();
      server?.closeAllConnections();
      await new Promise<void>((resolve) => {
        if (server) {
          server.close(() => resolve());
        } else {
          resolve();
        }
      });
      controller.abort();
      await run;
    }
  });

  it("stops ingress and the Bolt transport when ingress start throws", async () => {
    const startError = new Error("durable ingress unavailable");
    ingressStartMock.mockImplementation(() => {
      throw startError;
    });

    await expect(
      monitorSlackProvider({
        botToken: "bot-token",
        appToken: "app-token",
        config: getSlackTestState().config,
      }),
    ).rejects.toBe(startError);

    expect(ingressStopMock).toHaveBeenCalledTimes(1);
    expect(getSlackTestState().appStartMock).not.toHaveBeenCalled();
    expect(getSlackTestState().appStopMock).toHaveBeenCalledTimes(1);
  });
});
