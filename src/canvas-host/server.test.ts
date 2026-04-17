import fs from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import { A2UI_PATH, CANVAS_HOST_PATH, CANVAS_WS_PATH, injectCanvasLiveReload } from "./a2ui.js";

type MockWatcher = {
  on: (event: string, cb: (...args: unknown[]) => void) => MockWatcher;
  close: () => Promise<void>;
  __emit: (event: string, ...args: unknown[]) => void;
};

const CANVAS_RELOAD_TEST_TIMEOUT_MS = 20_000;

type TrackingWebSocket = {
  sent: string[];
  on: (event: string, cb: () => void) => TrackingWebSocket;
  send: (message: string) => void;
};

function isLoopbackBindDenied(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES";
}

function createMockWatcherState() {
  const watchers: MockWatcher[] = [];
  const createWatcher = () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const api: MockWatcher = {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(cb);
        handlers.set(event, list);
        return api;
      },
      close: async () => {},
      __emit: (event: string, ...args: unknown[]) => {
        for (const cb of handlers.get(event) ?? []) {
          cb(...args);
        }
      },
    };
    watchers.push(api);
    return api;
  };
  return {
    watchers,
    watchFactory: () => createWatcher(),
  };
}

describe("canvas host", () => {
  const quietRuntime = {
    ...defaultRuntime,
    log: (..._args: Parameters<typeof console.log>) => {},
  };
  let createCanvasHostHandler: typeof import("./server.js").createCanvasHostHandler;
  let startCanvasHost: typeof import("./server.js").startCanvasHost;
  let realFetch: typeof import("undici").fetch;
  let WebSocketServerClass: typeof import("ws").WebSocketServer;
  let watcherState: ReturnType<typeof createMockWatcherState>;
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createCaseDir = async () => {
    const dir = path.join(fixtureRoot, `case-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  const startFixtureCanvasHost = async (
    rootDir: string,
    overrides: Partial<Parameters<typeof startCanvasHost>[0]> = {},
  ) =>
    await startCanvasHost({
      runtime: quietRuntime,
      rootDir,
      port: 0,
      listenHost: "127.0.0.1",
      allowInTests: true,
      watchFactory: watcherState.watchFactory as unknown as Parameters<
        typeof startCanvasHost
      >[0]["watchFactory"],
      webSocketServerClass: WebSocketServerClass,
      ...overrides,
    });

  const fetchCanvasHtml = async (port: number) => {
    const res = await realFetch(`http://127.0.0.1:${port}${CANVAS_HOST_PATH}/`);
    const html = await res.text();
    return { res, html };
  };

  beforeAll(async () => {
    vi.doUnmock("undici");
    vi.resetModules();
    const require = createRequire(import.meta.url);
    ({ createCanvasHostHandler, startCanvasHost } = await import("./server.js"));
    ({ fetch: realFetch } = require("undici") as typeof import("undici"));
    const wsModule = await vi.importActual<typeof import("ws")>("ws");
    WebSocketServerClass = wsModule.WebSocketServer;
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-fixtures-"));
  });

  beforeEach(() => {
    vi.useRealTimers();
    watcherState = createMockWatcherState();
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("injects live reload script", () => {
    const out = injectCanvasLiveReload("<html><body>Hello</body></html>");
    expect(out).toContain(CANVAS_WS_PATH);
    expect(out).toContain("location.reload");
    expect(out).toContain("openclawCanvasA2UIAction");
    expect(out).toContain("openclawSendUserAction");
  });

  it("creates a default index.html when missing", async () => {
    const dir = await createCaseDir();
    let server: Awaited<ReturnType<typeof startFixtureCanvasHost>>;
    try {
      server = await startFixtureCanvasHost(dir);
    } catch (error) {
      if (isLoopbackBindDenied(error)) {
        return;
      }
      throw error;
    }

    try {
      const { res, html } = await fetchCanvasHtml(server.port);
      expect(res.status).toBe(200);
      expect(html).toContain("Interactive test page");
      expect(html).toContain("openclawSendUserAction");
      expect(html).toContain(CANVAS_WS_PATH);
      expect(html).toContain('document.createElement("span")');
      expect(html).not.toContain("statusEl.innerHTML");
    } finally {
      await server.close();
    }
  });

  it("skips live reload injection when disabled", async () => {
    const dir = await createCaseDir();
    await fs.writeFile(path.join(dir, "index.html"), "<html><body>no-reload</body></html>", "utf8");
    let server: Awaited<ReturnType<typeof startFixtureCanvasHost>>;
    try {
      server = await startFixtureCanvasHost(dir, { liveReload: false });
    } catch (error) {
      if (isLoopbackBindDenied(error)) {
        return;
      }
      throw error;
    }

    try {
      const { res, html } = await fetchCanvasHtml(server.port);
      expect(res.status).toBe(200);
      expect(html).toContain("no-reload");
      expect(html).not.toContain(CANVAS_WS_PATH);

      const wsRes = await realFetch(`http://127.0.0.1:${server.port}${CANVAS_WS_PATH}`);
      expect(wsRes.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("serves canvas content from the mounted base path and reuses handlers without double close", async () => {
    const dir = await createCaseDir();
    await fs.writeFile(path.join(dir, "index.html"), "<html><body>v1</body></html>", "utf8");

    const handler = await createCanvasHostHandler({
      runtime: quietRuntime,
      rootDir: dir,
      basePath: CANVAS_HOST_PATH,
      allowInTests: true,
      watchFactory: watcherState.watchFactory as unknown as Parameters<
        typeof createCanvasHostHandler
      >[0]["watchFactory"],
      webSocketServerClass: WebSocketServerClass,
    });

    const server = createServer((req, res) => {
      void (async () => {
        if (await handler.handleHttpRequest(req, res)) {
          return;
        }
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Not Found");
      })();
    });
    server.on("upgrade", (req, socket, head) => {
      if (handler.handleUpgrade(req, socket, head)) {
        return;
      }
      socket.destroy();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(0, "127.0.0.1");
      });
    } catch (error) {
      await handler.close();
      if (isLoopbackBindDenied(error)) {
        return;
      }
      throw error;
    }
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await realFetch(`http://127.0.0.1:${port}${CANVAS_HOST_PATH}/`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain("v1");
      expect(html).toContain(CANVAS_WS_PATH);

      const miss = await realFetch(`http://127.0.0.1:${port}/`);
      expect(miss.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
    const originalClose = handler.close;
    const closeSpy = vi.fn(async () => originalClose());
    handler.close = closeSpy;

    const hosted = await startCanvasHost({
      runtime: quietRuntime,
      handler,
      ownsHandler: false,
      port: 0,
      listenHost: "127.0.0.1",
      allowInTests: true,
    });

    try {
      expect(hosted.port).toBeGreaterThan(0);
    } finally {
      await hosted.close();
      expect(closeSpy).not.toHaveBeenCalled();
      await originalClose();
    }
  });

  it(
    "broadcasts reload on file changes",
    async () => {
      const dir = await createCaseDir();
      const index = path.join(dir, "index.html");
      await fs.writeFile(index, "<html><body>v1</body></html>", "utf8");

      const watcherStart = watcherState.watchers.length;
      const TrackingWebSocketServerClass = class TrackingWebSocketServer {
        static latestInstance: { connectionCount: number } | undefined;
        static latestSocket: TrackingWebSocket | undefined;
        connectionCount = 0;
        readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

        on(event: string, cb: (...args: unknown[]) => void) {
          const list = this.handlers.get(event) ?? [];
          list.push(cb);
          this.handlers.set(event, list);
          return this;
        }

        emit(event: string, ...args: unknown[]) {
          for (const cb of this.handlers.get(event) ?? []) {
            cb(...args);
          }
        }

        handleUpgrade(
          req: IncomingMessage,
          socket: Duplex,
          head: Buffer,
          cb: (ws: TrackingWebSocket) => void,
        ) {
          void req;
          void socket;
          void head;
          const closeHandlers: Array<() => void> = [];
          const ws: TrackingWebSocket = {
            sent: [],
            on: (event, handler) => {
              if (event === "close") {
                closeHandlers.push(handler);
              }
              return ws;
            },
            send: (message: string) => {
              ws.sent.push(message);
            },
          };
          TrackingWebSocketServerClass.latestSocket = ws;
          cb(ws);
        }

        close(cb?: (err?: Error) => void) {
          cb?.();
        }

        constructor(..._args: unknown[]) {
          TrackingWebSocketServerClass.latestInstance = this;
          this.on("connection", () => {
            this.connectionCount += 1;
          });
        }
      };

      const handler = await createCanvasHostHandler({
        runtime: quietRuntime,
        rootDir: dir,
        basePath: CANVAS_HOST_PATH,
        allowInTests: true,
        watchFactory: watcherState.watchFactory as unknown as Parameters<
          typeof createCanvasHostHandler
        >[0]["watchFactory"],
        webSocketServerClass:
          TrackingWebSocketServerClass as unknown as typeof import("ws").WebSocketServer,
      });

      try {
        const watcher = watcherState.watchers[watcherStart];
        expect(watcher).toBeTruthy();
        const upgraded = handler.handleUpgrade(
          { url: CANVAS_WS_PATH } as IncomingMessage,
          {} as Duplex,
          Buffer.alloc(0),
        );
        expect(upgraded).toBe(true);
        expect(TrackingWebSocketServerClass.latestInstance?.connectionCount).toBe(1);
        const ws = TrackingWebSocketServerClass.latestSocket;
        expect(ws).toBeTruthy();

        await fs.writeFile(index, "<html><body>v2</body></html>", "utf8");
        watcher.__emit("all", "change", index);
        await sleep(15);
        expect(ws?.sent[0]).toBe("reload");
      } finally {
        await handler.close();
      }
    },
    CANVAS_RELOAD_TEST_TIMEOUT_MS,
  );

  it("serves A2UI scaffold and blocks traversal/symlink escapes", async () => {
    const dir = await createCaseDir();
    const a2uiRoot = path.resolve(process.cwd(), "src/canvas-host/a2ui");
    const bundlePath = path.join(a2uiRoot, "a2ui.bundle.js");
    const linkName = `test-link-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
    const linkPath = path.join(a2uiRoot, linkName);
    let createdBundle = false;
    let createdLink = false;
    let server: Awaited<ReturnType<typeof startFixtureCanvasHost>> | undefined;

    try {
      await fs.stat(bundlePath);
    } catch {
      await fs.writeFile(bundlePath, "window.openclawA2UI = {};", "utf8");
      createdBundle = true;
    }

    await fs.symlink(path.join(process.cwd(), "package.json"), linkPath);
    createdLink = true;

    try {
      try {
        server = await startFixtureCanvasHost(dir);
      } catch (error) {
        if (isLoopbackBindDenied(error)) {
          return;
        }
        throw error;
      }

      const res = await realFetch(`http://127.0.0.1:${server.port}/__openclaw__/a2ui/`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain("openclaw-a2ui-host");
      expect(html).toContain("openclawCanvasA2UIAction");

      const bundleRes = await realFetch(
        `http://127.0.0.1:${server.port}/__openclaw__/a2ui/a2ui.bundle.js`,
      );
      const js = await bundleRes.text();
      expect(bundleRes.status).toBe(200);
      expect(js).toContain("openclawA2UI");
      const traversalRes = await realFetch(
        `http://127.0.0.1:${server.port}${A2UI_PATH}/%2e%2e%2fpackage.json`,
      );
      expect(traversalRes.status).toBe(404);
      expect(await traversalRes.text()).toBe("not found");
      const symlinkRes = await realFetch(`http://127.0.0.1:${server.port}${A2UI_PATH}/${linkName}`);
      expect(symlinkRes.status).toBe(404);
      expect(await symlinkRes.text()).toBe("not found");
    } finally {
      await server?.close();
      if (createdLink) {
        await fs.rm(linkPath, { force: true });
      }
      if (createdBundle) {
        await fs.rm(bundlePath, { force: true });
      }
    }
  });
});
