// Canvas tests cover server plugin behavior.
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import vm from "node:vm";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { A2UI_PATH, CANVAS_HOST_PATH, CANVAS_WS_PATH, injectCanvasRuntime } from "./a2ui-shared.js";

type MockWatcher = {
  on: (event: string, cb: (...args: unknown[]) => void) => MockWatcher;
  close: () => Promise<void>;
  __emit: (event: string, ...args: unknown[]) => void;
};

type CanvasWatchFactory = NonNullable<
  Parameters<typeof import("./server.js").createCanvasHostHandler>[0]["watchFactory"]
>;
type CanvasWatchCall = {
  root: Parameters<CanvasWatchFactory>[0];
  options: Parameters<CanvasWatchFactory>[1];
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
  bodyBytes: Buffer;
};

type HttpRequestHandler = (
  req: IncomingMessage,
  res: import("node:http").ServerResponse,
) => boolean | Promise<boolean>;

function createMockWatcherState() {
  const watchers: MockWatcher[] = [];
  const watchCalls: CanvasWatchCall[] = [];
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
    watchCalls,
    watchFactory: ((root: CanvasWatchCall["root"], options: CanvasWatchCall["options"]) => {
      watchCalls.push({ root, options });
      return createWatcher();
    }) as unknown as CanvasWatchFactory,
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
    bodyBytes: Buffer.alloc(0),
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
      response.bodyBytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? "");
      response.body = response.bodyBytes.toString("utf8");
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

async function captureA2uiFixtureResponse(
  rootDir: string,
  url: string,
  method = "GET",
  liveReload = true,
): Promise<CapturedResponse> {
  const { createA2uiHttpRequestHandler } = await import("./a2ui.js");
  return await captureHttpResponse(
    createA2uiHttpRequestHandler({ rootDir, liveReload }),
    url,
    method,
  );
}

function extractInjectedScript(html: string): string {
  const match = html.match(/<script>([\s\S]+)<\/script>/);
  if (!match?.[1]) {
    throw new Error("expected injected canvas live reload script");
  }
  return match[1];
}

type MockLiveReloadSocket = {
  onclose?: (event: { code: number; reason: string }) => void;
  onerror?: (event: Error) => void;
  onmessage?: (event: { data?: string }) => void;
};

function runInjectedScript(
  WebSocket: (this: MockLiveReloadSocket, url: string) => void,
  locationOverrides: Partial<{ pathname: string; search: string }> = {},
) {
  const consoleError = vi.fn();
  let pagehide: (() => void) | undefined;
  let pageshow: (() => void) | undefined;
  const runtime: Record<string, unknown> = {
    URLSearchParams,
    WebSocket,
    addEventListener: (event: string, listener: () => void) => {
      if (event === "pagehide") {
        pagehide = listener;
      }
      if (event === "pageshow") {
        pageshow = listener;
      }
    },
    console: { error: consoleError },
    encodeURIComponent,
    location: {
      host: "control.example",
      protocol: "https:",
      pathname: "/__openclaw__/canvas/",
      reload: vi.fn(),
      search: "",
      ...locationOverrides,
    },
  };
  runtime.window = runtime;
  runtime.self = runtime;
  runtime.globalThis = runtime;
  vm.createContext(runtime);
  vm.runInContext(
    extractInjectedScript(injectCanvasRuntime("<html><body>Hello</body></html>")),
    runtime,
  );
  return {
    consoleError,
    pagehide: () => pagehide?.(),
    pageshow: () => pageshow?.(),
  };
}

describe("canvas host", () => {
  const quietRuntime = {
    ...defaultRuntime,
    log: (..._args: Parameters<typeof console.log>) => {},
  };
  let createCanvasHostHandler: typeof import("./server.js").createCanvasHostHandler;
  let startCanvasHost: typeof import("./server.js").startCanvasHost;
  let canvasLiveReloadMaxInboundMessageBytes = 0;
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
    const serverModule = await import("./server.js");
    ({ createCanvasHostHandler, startCanvasHost } = serverModule);
    canvasLiveReloadMaxInboundMessageBytes =
      serverModule.CANVAS_LIVE_RELOAD_MAX_INBOUND_MESSAGE_BYTES;
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

  it("injects the Canvas runtime before authored page scripts", () => {
    const authoredScript = "globalThis.bridgeReadyAtStartup = typeof openclawSendUserAction";
    const out = injectCanvasRuntime(
      `<!doctype html><html><head><script>${authoredScript}</script></head><body>Hello</body></html>`,
    );
    expect(out).toContain(CANVAS_WS_PATH);
    expect(out).toContain("location.reload");
    expect(out).toContain("openclawCanvasA2UIAction");
    expect(out).toContain("openclawSendUserAction");
    expect(out).toContain("crypto?.getRandomValues");
    expect(out).not.toContain("String(Date.now())");
    expect(out.indexOf("globalThis.OpenClaw.postMessage")).toBeGreaterThan(out.indexOf("<head>"));
    expect(out.indexOf("globalThis.OpenClaw.postMessage")).toBeLessThan(
      out.indexOf(authoredScript),
    );
  });

  it("keeps the Canvas bridge when live reload is disabled", () => {
    const out = injectCanvasRuntime("<html><body>Hello</body></html>", { liveReload: false });
    expect(out).toContain("openclawCanvasA2UIAction");
    expect(out).toContain("openclawSendUserAction");
    expect(out).not.toContain(CANVAS_WS_PATH);
    expect(out).not.toContain("new WebSocket");
  });

  it("ignores commented tags and quoted closing brackets when injecting", () => {
    const authoredScript = "globalThis.bridgeReadyAfterComment = typeof openclawSendUserAction";
    const comment = "<!-- example: <head> -->";
    const head = '<head data-note="quoted > bracket">';
    const out = injectCanvasRuntime(
      `${comment}\n${head}<script>${authoredScript}</script><body>Hello</body>`,
    );

    expect(out.indexOf("globalThis.OpenClaw.postMessage")).toBeGreaterThan(out.indexOf(head));
    expect(out.indexOf("globalThis.OpenClaw.postMessage")).toBeLessThan(
      out.indexOf(authoredScript),
    );
    expect(out.slice(0, out.indexOf(head))).toBe(`${comment}\n`);
  });

  it("reports websocket initialization errors instead of swallowing them silently", () => {
    function ThrowingWebSocket(): never {
      throw new TypeError("constructor failed");
    }
    const { consoleError } = runInjectedScript(ThrowingWebSocket);

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("OpenClaw canvas live reload unavailable");
  });

  it("reports asynchronous websocket connection errors once", () => {
    const sockets: MockLiveReloadSocket[] = [];
    function CapturingWebSocket(this: MockLiveReloadSocket): void {
      sockets.push(this);
    }
    const { consoleError } = runInjectedScript(CapturingWebSocket);

    expect(sockets).toHaveLength(1);
    sockets[0]?.onerror?.(new Error("connect failed"));
    sockets[0]?.onclose?.({ code: 1006, reason: "abnormal closure" });

    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("does not report a normal close after connecting", () => {
    const sockets: MockLiveReloadSocket[] = [];
    const { consoleError, pagehide } = runInjectedScript(function (this: MockLiveReloadSocket) {
      sockets.push(this);
    });

    pagehide();
    sockets[0]?.onclose?.({ code: 1001, reason: "page closed" });

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("resets page-unload state when a persisted page is shown again", () => {
    const sockets: MockLiveReloadSocket[] = [];
    const { consoleError, pagehide, pageshow } = runInjectedScript(
      function (this: MockLiveReloadSocket) {
        sockets.push(this);
      },
    );

    pagehide();
    pageshow();
    sockets[0]?.onclose?.({ code: 1001, reason: "server closed" });

    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("uses a path-scoped capability ahead of a stale query capability", () => {
    const urls: string[] = [];
    runInjectedScript(
      function (this: MockLiveReloadSocket, url: string) {
        urls.push(url);
      },
      {
        pathname: "/__openclaw__/cap/current-token/__openclaw__/canvas/",
        search: "?oc_cap=stale-token",
      },
    );

    expect(urls).toEqual([`wss://control.example${CANVAS_WS_PATH}?oc_cap=current-token`]);
  });

  it("reports an abnormal close without a preceding error event", () => {
    const sockets: MockLiveReloadSocket[] = [];
    const { consoleError } = runInjectedScript(function (this: MockLiveReloadSocket) {
      sockets.push(this);
    });

    sockets[0]?.onclose?.({ code: 1011, reason: "server error" });

    expect(consoleError).toHaveBeenCalledTimes(1);
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

  it("keeps bridge injection but skips live reload when disabled", async () => {
    const dir = await createCaseDir();
    await fs.writeFile(path.join(dir, "index.html"), "<html><body>no-reload</body></html>", "utf8");
    const handler = await createTestCanvasHostHandler(dir, { liveReload: false });

    try {
      const response = await captureHandlerResponse(handler, `${CANVAS_HOST_PATH}/`);
      expect(response.status).toBe(200);
      expect(response.body).toContain("no-reload");
      expect(response.body).toContain("openclawSendUserAction");
      expect(response.body).not.toContain(CANVAS_WS_PATH);

      const wsResponse = await captureHandlerResponse(handler, CANVAS_WS_PATH);
      expect(wsResponse.status).toBe(404);
    } finally {
      await handler.close();
    }
  });

  it("watches Canvas content when the state directory is hidden", async () => {
    const dir = path.join(fixtureRoot, ".openclaw", `case-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    const handler = await createTestCanvasHostHandler(dir);

    try {
      const call = watcherState.watchCalls.at(-1);
      expect(call?.root).toBe(await fs.realpath(dir));
      const ignored = call?.options?.ignored;
      expect(ignored).toBeTypeOf("function");
      const shouldIgnore = ignored as (candidatePath: string) => boolean;
      expect(shouldIgnore(dir)).toBe(false);
      expect(shouldIgnore(path.join(dir, "index.html"))).toBe(false);
      expect(shouldIgnore(path.join(dir, ".draft.html"))).toBe(true);
      expect(shouldIgnore(path.join(dir, "node_modules", "asset.js"))).toBe(true);
    } finally {
      await handler.close();
    }
  });

  it("serves sandbox-marked documents with a CSP sandbox header and no live reload", async () => {
    const dir = await createCaseDir();
    const docDir = path.join(dir, "documents", "widget-1");
    await fs.mkdir(docDir, { recursive: true });
    await fs.writeFile(
      path.join(docDir, "manifest.json"),
      JSON.stringify({ id: "widget-1", cspSandbox: "scripts" }),
      "utf8",
    );
    await fs.writeFile(path.join(docDir, "index.html"), "<html><body>widget</body></html>", "utf8");
    const plainDir = path.join(dir, "documents", "plain-1");
    await fs.mkdir(plainDir, { recursive: true });
    await fs.writeFile(
      path.join(plainDir, "manifest.json"),
      JSON.stringify({ id: "plain-1" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(plainDir, "index.html"),
      "<html><body>plain</body></html>",
      "utf8",
    );
    const handler = await createTestCanvasHostHandler(dir);

    try {
      const widget = await captureHandlerResponse(
        handler,
        `${CANVAS_HOST_PATH}/documents/widget-1/index.html`,
      );
      expect(widget.status).toBe(200);
      // Opaque origin on direct navigation: widget script must not run as the app origin.
      expect(widget.headers["content-security-policy"]).toBe("sandbox allow-scripts");
      expect(widget.body).toContain("widget");
      expect(widget.body).not.toContain(CANVAS_WS_PATH);

      const plain = await captureHandlerResponse(
        handler,
        `${CANVAS_HOST_PATH}/documents/plain-1/index.html`,
      );
      expect(plain.status).toBe(200);
      expect(plain.headers["content-security-policy"]).toBeUndefined();
    } finally {
      await handler.close();
    }
  });

  it("caps live reload WebSocket inbound payloads", async () => {
    const dir = await createCaseDir();
    const constructorOptions: unknown[] = [];
    let connectionHandler: ((socket: TrackingWebSocket) => void) | undefined;
    class CapturingWebSocketServer {
      on(event: string, cb: (socket: TrackingWebSocket) => void) {
        if (event === "connection") {
          connectionHandler = cb;
        }
        return this;
      }

      close(cb?: () => void) {
        cb?.();
      }

      constructor(options: unknown) {
        constructorOptions.push(options);
      }
    }

    const handler = await createTestCanvasHostHandler(dir, {
      webSocketServerClass:
        CapturingWebSocketServer as unknown as typeof import("ws").WebSocketServer,
    });

    try {
      expect(constructorOptions[0]).toMatchObject({
        noServer: true,
        maxPayload: canvasLiveReloadMaxInboundMessageBytes,
      });
      const socketHandlers: string[] = [];
      const socket: TrackingWebSocket = {
        sent: [],
        on: (event) => {
          socketHandlers.push(event);
          return socket;
        },
        send: vi.fn(),
      };
      expect(connectionHandler).toBeDefined();
      connectionHandler?.(socket);
      expect(socketHandlers).toEqual(expect.arrayContaining(["error", "close"]));
    } finally {
      await handler.close();
    }
  });

  it("falls back to the default mount when the configured base path is malformed", async () => {
    const dir = await createCaseDir();
    await fs.writeFile(path.join(dir, "index.html"), "<html><body>fallback</body></html>", "utf8");
    const handler = await createTestCanvasHostHandler(dir, { basePath: "/%E0%A4%A" });

    try {
      const response = await captureHandlerResponse(handler, `${CANVAS_HOST_PATH}/`);
      expect(response.status).toBe(200);
      expect(response.body).toContain("fallback");
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

      const malformed = await captureHandlerResponse(handler, `${CANVAS_HOST_PATH}/%E0%A4%A`);
      expect(malformed.status).toBe(404);
      expect(malformed.body).toBe("not found");

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
    let resolveReload: (() => void) | undefined;
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
              if (!resolveReload) {
                throw new Error("Expected Canvas reload resolver to be initialized");
              }
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
      if (!watcher) {
        throw new Error("expected Canvas host watcher");
      }
      const upgraded = handler.handleUpgrade(
        { url: CANVAS_WS_PATH } as IncomingMessage,
        {} as Duplex,
        Buffer.alloc(0),
      );
      expect(upgraded).toBe(true);
      const latestServer = TrackingWebSocketServerClass.latestInstance;
      if (!latestServer) {
        throw new Error("expected Canvas host websocket server");
      }
      expect(latestServer.connectionCount).toBe(1);
      const ws = TrackingWebSocketServerClass.latestSocket;
      if (!ws) {
        throw new Error("expected Canvas host websocket");
      }

      await fs.writeFile(index, "<html><body>v2</body></html>", "utf8");
      watcher["__emit"]("all", "change", index);
      await reloadSent;
      expect(ws.sent[0]).toBe("reload");
    } finally {
      await handler.close();
    }
  });

  it("serves A2UI scaffold and blocks traversal/symlink escapes", async () => {
    const a2uiRoot = await createCaseDir();
    const nestedAssetDir = path.join(a2uiRoot, "assets", "demo");
    const linkName = `test-link-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
    const linkPath = path.join(a2uiRoot, linkName);

    await fs.mkdir(nestedAssetDir, { recursive: true });
    await fs.writeFile(
      path.join(a2uiRoot, "index.html"),
      `<openclaw-a2ui-host></openclaw-a2ui-host>
<script>openclawCanvasA2UIAction</script>`,
      "utf8",
    );
    await fs.writeFile(path.join(a2uiRoot, "a2ui.bundle.js"), "window.openclawA2UI = {};", "utf8");
    await fs.writeFile(path.join(nestedAssetDir, "sample.txt"), "nested asset", "utf8");
    await fs.symlink(path.join(process.cwd(), "package.json"), linkPath);

    try {
      const res = await captureA2uiFixtureResponse(a2uiRoot, `${A2UI_PATH}/`);
      const html = res.body;
      expect(res.status).toBe(200);
      expect(html).toContain("openclaw-a2ui-host");
      expect(html).toContain("openclawCanvasA2UIAction");

      const noReloadRes = await captureA2uiFixtureResponse(a2uiRoot, `${A2UI_PATH}/`, "GET", false);
      expect(noReloadRes.body).toContain("openclawCanvasA2UIAction");
      expect(noReloadRes.body).not.toContain(CANVAS_WS_PATH);

      const bundleRes = await captureA2uiFixtureResponse(a2uiRoot, `${A2UI_PATH}/a2ui.bundle.js`);
      const js = bundleRes.body;
      expect(bundleRes.status).toBe(200);
      expect(js).toContain("openclawA2UI");

      const assetRes = await captureA2uiFixtureResponse(
        a2uiRoot,
        `${A2UI_PATH}/assets/demo/sample.txt`,
      );
      expect(assetRes.status).toBe(200);
      expect(assetRes.headers["content-type"]).toBe("text/plain");
      expect(assetRes.body).toBe("nested asset");

      const traversalRes = await captureA2uiFixtureResponse(
        a2uiRoot,
        `${A2UI_PATH}/%2e%2e%2fpackage.json`,
      );
      expect(traversalRes.status).toBe(404);
      expect(traversalRes.body).toBe("not found");
      const malformedRes = await captureA2uiFixtureResponse(a2uiRoot, `${A2UI_PATH}/%E0%A4%A`);
      expect(malformedRes.status).toBe(404);
      expect(malformedRes.body).toBe("not found");
      const symlinkRes = await captureA2uiFixtureResponse(a2uiRoot, `${A2UI_PATH}/${linkName}`);
      expect(symlinkRes.status).toBe(404);
      expect(symlinkRes.body).toBe("not found");
    } finally {
      await fs.rm(linkPath, { force: true });
    }
  });
});
