import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import {
  A2UI_PATH,
  CANVAS_HOST_PATH,
  CANVAS_WS_PATH,
  injectCanvasLiveReload,
} from "./a2ui-shared.js";

type MockWatcher = {
  on: (event: string, cb: (...args: unknown[]) => void) => MockWatcher;
  close: () => Promise<void>;
  __emit: (event: string, ...args: unknown[]) => void;
};

type TrackingWebSocket = {
  sent: string[];
  on: (event: string, cb: () => void) => TrackingWebSocket;
  send: (message: string) => void;
};

type CapturedResponse = {
  handled: boolean;
  status: number;
  headers: Record<string, number | string | string[]>;
  body: string;
};

type HttpRequestHandler = (
  req: IncomingMessage,
  res: import("node:http").ServerResponse,
) => boolean | Promise<boolean>;

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

async function captureHttpResponse(
  handleRequest: HttpRequestHandler,
  url: string,
  method = "GET",
): Promise<CapturedResponse> {
  const response: CapturedResponse = {
    handled: false,
    status: 200,
    headers: {},
    body: "",
  };
  const res = {
    statusCode: 200,
    setHeader(name: string, value: number | string | readonly string[]) {
      const headerValue: number | string | string[] =
        typeof value === "object" ? [...value] : value;
      response.headers[name.toLowerCase()] = headerValue;
      return this;
    },
    end(chunk?: string | Buffer) {
      response.status = this.statusCode;
      response.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : (chunk ?? "");
      return this;
    },
  };
  response.handled = await handleRequest(
    { method, url } as IncomingMessage,
    res as import("node:http").ServerResponse,
  );
  response.status = res.statusCode;
  return response;
}

async function captureHandlerResponse(
  handler: Pick<import("./server.js").CanvasHostHandler, "handleHttpRequest">,
  url: string,
  method = "GET",
): Promise<CapturedResponse> {
  return await captureHttpResponse(handler.handleHttpRequest, url, method);
}

async function captureA2uiResponse(url: string, method = "GET"): Promise<CapturedResponse> {
  const { handleA2uiHttpRequest } = await import("./a2ui.js");
  return await captureHttpResponse(handleA2uiHttpRequest, url, method);
}

describe("canvas host", () => {
  const quietRuntime = {
    ...defaultRuntime,
    log: (..._args: Parameters<typeof console.log>) => {},
  };
  let createCanvasHostHandler: typeof import("./server.js").createCanvasHostHandler;
  let startCanvasHost: typeof import("./server.js").startCanvasHost;
  let WebSocketServerClass: typeof import("ws").WebSocketServer;
  let watcherState: ReturnType<typeof createMockWatcherState>;
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createCaseDir = async () => {
    const dir = path.join(fixtureRoot, `case-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  const createTestCanvasHostHandler = async (
    rootDir: string,
    options: Partial<Parameters<typeof createCanvasHostHandler>[0]> = {},
  ) =>
    await createCanvasHostHandler({
      runtime: quietRuntime,
      rootDir,
      basePath: CANVAS_HOST_PATH,
      allowInTests: true,
      watchFactory: watcherState.watchFactory as unknown as Parameters<
        typeof createCanvasHostHandler
      >[0]["watchFactory"],
      webSocketServerClass: WebSocketServerClass,
      ...options,
    });

  beforeAll(async () => {
    vi.doUnmock("undici");
    vi.doMock("node:timers", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:timers")>();
      return {
        ...actual,
        setTimeout: ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
          actual.setTimeout(
            callback,
            delay === 12 ? 0 : delay,
            ...args,
          )) as typeof actual.setTimeout,
      };
    });
    vi.resetModules();
    ({ createCanvasHostHandler, startCanvasHost } = await import("./server.js"));
    const wsModule = await vi.importActual<typeof import("ws")>("ws");
    WebSocketServerClass = wsModule.WebSocketServer;
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-fixtures-"));
  });

  beforeEach(() => {
    vi.useRealTimers();
    watcherState = createMockWatcherState();
  });

  afterAll(async () => {
    vi.doUnmock("node:timers");
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
    const handler = await createTestCanvasHostHandler(dir);

    try {
      const response = await captureHandlerResponse(handler, `${CANVAS_HOST_PATH}/`);
      expect(response.status).toBe(200);
      expect(response.body).toContain("Interactive test page");
      expect(response.body).toContain("openclawSendUserAction");
      expect(response.body).toContain(CANVAS_WS_PATH);
      expect(response.body).toContain('document.createElement("span")');
      expect(response.body).not.toContain("statusEl.innerHTML");
    } finally {
      await handler.close();
    }
  });

  it("skips live reload injection when disabled", async () => {
    const dir = await createCaseDir();
    await fs.writeFile(path.join(dir, "index.html"), "<html><body>no-reload</body></html>", "utf8");
    const handler = await createTestCanvasHostHandler(dir, { liveReload: false });

    try {
      const response = await captureHandlerResponse(handler, `${CANVAS_HOST_PATH}/`);
      expect(response.status).toBe(200);
      expect(response.body).toContain("no-reload");
      expect(response.body).not.toContain(CANVAS_WS_PATH);

      const wsResponse = await captureHandlerResponse(handler, CANVAS_WS_PATH);
      expect(wsResponse.status).toBe(404);
    } finally {
      await handler.close();
    }
  });

  it("serves canvas content from the mounted base path and reuses handlers without double close", async () => {
    const dir = await createCaseDir();
    await fs.writeFile(path.join(dir, "index.html"), "<html><body>v1</body></html>", "utf8");

    const handler = await createTestCanvasHostHandler(dir);

    const originalClose = handler.close;
    const closeSpy = vi.fn(async () => originalClose());

    try {
      const response = await captureHandlerResponse(handler, `${CANVAS_HOST_PATH}/`);
      expect(response.status).toBe(200);
      expect(response.body).toContain("v1");
      expect(response.body).toContain(CANVAS_WS_PATH);

      const miss = await captureHandlerResponse(handler, "/");
      expect(miss.handled).toBe(false);

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
      }
    } finally {
      await originalClose();
    }
  });

  it("broadcasts reload on file changes", async () => {
    const dir = await createCaseDir();
    const index = path.join(dir, "index.html");
    await fs.writeFile(index, "<html><body>v1</body></html>", "utf8");
    let resolveReload!: () => void;
    const reloadSent = new Promise<void>((resolve) => {
      resolveReload = resolve;
    });

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
            if (message === "reload") {
              resolveReload();
            }
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

    const handler = await createTestCanvasHostHandler(dir, {
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
      await reloadSent;
      expect(ws?.sent[0]).toBe("reload");
    } finally {
      await handler.close();
    }
  });

  it("serves A2UI scaffold and blocks traversal/symlink escapes", async () => {
    const a2uiRoot = path.resolve(process.cwd(), "src/canvas-host/a2ui");
    const bundlePath = path.join(a2uiRoot, "a2ui.bundle.js");
    const linkName = `test-link-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
    const linkPath = path.join(a2uiRoot, linkName);
    let createdBundle = false;
    let createdLink = false;

    try {
      await fs.stat(bundlePath);
    } catch {
      await fs.writeFile(bundlePath, "window.openclawA2UI = {};", "utf8");
      createdBundle = true;
    }

    await fs.symlink(path.join(process.cwd(), "package.json"), linkPath);
    createdLink = true;

    try {
      const res = await captureA2uiResponse(`${A2UI_PATH}/`);
      const html = res.body;
      expect(res.status).toBe(200);
      expect(html).toContain("openclaw-a2ui-host");
      expect(html).toContain("openclawCanvasA2UIAction");

      const bundleRes = await captureA2uiResponse(`${A2UI_PATH}/a2ui.bundle.js`);
      const js = bundleRes.body;
      expect(bundleRes.status).toBe(200);
      expect(js).toContain("openclawA2UI");
      const traversalRes = await captureA2uiResponse(`${A2UI_PATH}/%2e%2e%2fpackage.json`);
      expect(traversalRes.status).toBe(404);
      expect(traversalRes.body).toBe("not found");
      const symlinkRes = await captureA2uiResponse(`${A2UI_PATH}/${linkName}`);
      expect(symlinkRes.status).toBe(404);
      expect(symlinkRes.body).toBe("not found");
    } finally {
      if (createdLink) {
        await fs.rm(linkPath, { force: true });
      }
      if (createdBundle) {
        await fs.rm(bundlePath, { force: true });
      }
    }
  });
});
