import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runLinkUnderstanding } from "./runner.js";

const mocks = vi.hoisted(() => ({
  bodyCancel: vi.fn(),
  releaseAfterCancel: vi.fn(),
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) => {
      // Keep the real guarded transport while allowing only this test's loopback server.
      const result = await actual.fetchWithSsrFGuard({
        ...params,
        lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
        policy: { ...params.policy, allowPrivateNetwork: true },
      });
      const body = result.response.body;
      if (body) {
        const cancel = body.cancel.bind(body);
        vi.spyOn(body, "cancel").mockImplementation(async (reason?: unknown) => {
          mocks.bodyCancel(reason);
          await cancel(reason);
        });
      }
      const release = result.release;
      result.release = async () => {
        mocks.releaseAfterCancel(mocks.bodyCancel.mock.calls.length > 0);
        await release();
      };
      return result;
    },
  };
});

vi.mock("../process/exec.js", async () => {
  const actual = await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  return {
    ...actual,
    runCommandWithTimeout: mocks.runCommandWithTimeout,
  };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

describe("runLinkUnderstanding transport cleanup", () => {
  it("cancels a non-OK response body before releasing its guarded transport", async () => {
    const sockets = new Set<Socket>();
    const requestSocketClosed = deferred();
    const server = createServer((request, response) => {
      request.socket.once("close", requestSocketClosed.resolve);
      response.writeHead(500, {
        "content-length": "1000000",
        "content-type": "text/plain",
      });
      // Leave the declared body unfinished so cleanup must actively cancel it.
      response.write("error");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

    try {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const port = (server.address() as AddressInfo).port;
      const url = `http://loopback.test:${port}/error`;

      const resultPromise = runLinkUnderstanding({
        cfg: {
          tools: {
            links: {
              enabled: true,
              models: [{ type: "cli", command: "summarize" }],
            },
          },
        } as OpenClawConfig,
        ctx: { Body: `see ${url}` } as MsgContext,
      });

      const result = await within(resultPromise, 1000, "link understanding did not finish");
      expect(result).toEqual({ urls: [url], outputs: [] });
      await within(requestSocketClosed.promise, 1000, "loopback socket stayed open");

      expect(mocks.bodyCancel).toHaveBeenCalledOnce();
      expect(mocks.releaseAfterCancel).toHaveBeenCalledWith(true);
      expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
