import { createServer, type RequestListener } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { killPidIfAlive, waitForPidFile, waitForPidToExit } from "../test-utils/process-tree.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { applyLinkUnderstanding } from "./apply.js";
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
    runCommandWithTimeout: mocks.runCommandWithTimeout.mockImplementation(
      actual.runCommandWithTimeout,
    ),
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

async function withServer(handler: RequestListener, run: (base: string) => Promise<void>) {
  const sockets = new Set<Socket>();
  const server = createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run(`http://loopback.test:${(server.address() as AddressInfo).port}`);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function config(args: string[], timeoutSeconds = 10): OpenClawConfig {
  return {
    tools: {
      links: { models: [{ command: process.execPath, args, timeoutSeconds: 10 }], timeoutSeconds },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

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
      expect(result).toEqual([]);
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

it("cancels a streaming response and preserves the unmodified inbound context", async () => {
  const requestStarted = deferred();
  const socketClosed = deferred();
  const requests: string[] = [];
  await withServer(
    (req, res) => {
      requests.push(req.url ?? "");
      req.socket.once("close", socketClosed.resolve);
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial page");
      requestStarted.resolve();
    },
    async (base) => {
      const controller = new AbortController();
      const ctx: MsgContext = { Body: `${base}/first ${base}/second` };
      const original = { ...ctx };
      const result = applyLinkUnderstanding({
        cfg: config(["-e", "throw new Error('processor must not start')"]),
        ctx,
        signal: controller.signal,
      });
      const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
      await requestStarted.promise;
      controller.abort(new Error("operator stopped the reply"));
      await rejected;
      await socketClosed.promise;
      expect(ctx).toEqual(original);
      expect(requests).toEqual(["/first"]);
    },
  );
});

it("skips a timed-out streaming link and processes the next link", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      if (req.url === "/slow") {
        res.write("unfinished");
      } else {
        res.end("complete page");
      }
    },
    async (base) => {
      const ctx: MsgContext = { Body: `${base}/slow ${base}/good` };
      await applyLinkUnderstanding({
        cfg: config(["-e", "process.stdin.pipe(process.stdout)"], 0.5),
        ctx,
        signal: new AbortController().signal,
      });
      expect(ctx.LinkUnderstanding).toEqual(["complete page"]);
    },
  );
});

it("fetches only bare URLs from messages that also contain titled markdown links", async () => {
  const requests: string[] = [];
  await withServer(
    (req, res) => {
      const requestPath = req.url ?? "";
      requests.push(requestPath);
      res.end(requestPath);
    },
    async (base) => {
      const firstBare = `${base}/bare-one`;
      const secondBare = `${base}/bare-two`;
      const ctx: MsgContext = {
        Body: [
          `[quoted](${base}/quoted "Docs")`,
          `[parenthesized](${base}/parenthesized (Docs))`,
          `[escaped](${base}/escaped "A \\"quoted\\" title")`,
          firstBare,
          `[angle](<${base}/angle> 'Docs')`,
          secondBare,
        ].join(" "),
      };

      await applyLinkUnderstanding({
        cfg: config(["-e", "process.stdin.pipe(process.stdout)"]),
        ctx,
      });

      expect(requests).toEqual(["/bare-one", "/bare-two"]);
      expect(ctx.LinkUnderstanding).toEqual(["/bare-one", "/bare-two"]);
    },
  );
});

it("stops processor descendants after caller cancellation", async () => {
  await withTempDir("openclaw-link-cancel-", async (dir) => {
    const pidPath = path.join(dir, "worker.pid");
    const workerSource = "setInterval(() => {}, 1000); process.send('ready')";
    const wrapperSource = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `const worker = spawn(process.execPath, ['-e', ${JSON.stringify(workerSource)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })`,
      `worker.once('message', () => writeFileSync(${JSON.stringify(pidPath)}, String(worker.pid)))`,
      "process.stdin.resume()",
    ].join(";");
    await withServer(
      (_req, res) => res.end("page body"),
      async (base) => {
        const controller = new AbortController();
        const ctx: MsgContext = { Body: `${base}/page` };
        const original = { ...ctx };
        let workerPid: number | undefined;
        const result = applyLinkUnderstanding({
          cfg: config(["-e", wrapperSource]),
          ctx,
          signal: controller.signal,
        });
        const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
        try {
          workerPid = await waitForPidFile(pidPath);
          expect(isPidAlive(workerPid)).toBe(true);
          controller.abort();
          await rejected;
          expect(ctx).toEqual(original);
          expect(await waitForPidToExit(workerPid, 500)).toBe(true);
        } finally {
          controller.abort();
          killPidIfAlive(workerPid);
          await rejected;
        }
      },
    );
  });
});
