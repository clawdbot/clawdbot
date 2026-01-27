import { type AddressInfo, createServer } from "node:net";
import { fetch as realFetch } from "undici";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let testPort = 0;
let cdpBaseUrl = "";
let reachable = false;
let cfgAttachOnly = false;
let cfgEvaluateEnabled = true;
let createTargetId: string | null = null;
let prevGatewayPort: string | undefined;

const cdpMocks = vi.hoisted(() => ({
  createTargetViaCdp: vi.fn(async () => {
    throw new Error("cdp disabled");
  }),
  snapshotAria: vi.fn(async () => ({
    nodes: [{ ref: "1", role: "link", name: "x", depth: 0 }],
  })),
}));

const pwMocks = vi.hoisted(() => ({
  armDialogViaPlaywright: vi.fn(async () => {}),
  armFileUploadViaPlaywright: vi.fn(async () => {}),
  clickViaPlaywright: vi.fn(async () => {}),
  closePageViaPlaywright: vi.fn(async () => {}),
  closePlaywrightBrowserConnection: vi.fn(async () => {}),
  downloadViaPlaywright: vi.fn(async () => ({
    url: "https://example.com/report.pdf",
    suggestedFilename: "report.pdf",
    path: "/tmp/report.pdf",
  })),
  dragViaPlaywright: vi.fn(async () => {}),
  evaluateViaPlaywright: vi.fn(async () => "ok"),
  fillFormViaPlaywright: vi.fn(async () => {}),
  getConsoleMessagesViaPlaywright: vi.fn(async () => []),
  hoverViaPlaywright: vi.fn(async () => {}),
  scrollIntoViewViaPlaywright: vi.fn(async () => {}),
  navigateViaPlaywright: vi.fn(async () => ({ url: "https://example.com" })),
  pdfViaPlaywright: vi.fn(async () => ({ buffer: Buffer.from("pdf") })),
  pressKeyViaPlaywright: vi.fn(async () => {}),
  responseBodyViaPlaywright: vi.fn(async () => ({
    url: "https://example.com/api/data",
    status: 200,
    headers: { "content-type": "application/json" },
    body: '{"ok":true}',
  })),
  resizeViewportViaPlaywright: vi.fn(async () => {}),
  selectOptionViaPlaywright: vi.fn(async () => {}),
  setInputFilesViaPlaywright: vi.fn(async () => {}),
  snapshotAiViaPlaywright: vi.fn(async () => ({ snapshot: "ok" })),
  takeScreenshotViaPlaywright: vi.fn(async () => ({
    buffer: Buffer.from("png"),
  })),
  typeViaPlaywright: vi.fn(async () => {}),
  waitForDownloadViaPlaywright: vi.fn(async () => ({
    url: "https://example.com/report.pdf",
    suggestedFilename: "report.pdf",
    path: "/tmp/report.pdf",
  })),
  waitForViaPlaywright: vi.fn(async () => {}),
}));

function makeProc(pid = 123) {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    pid,
    killed: false,
    exitCode: null as number | null,
    on: (event: string, cb: (...args: unknown[]) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), cb]);
      return undefined;
    },
    emitExit: () => {
      for (const cb of handlers.get("exit") ?? []) cb(0);
    },
    kill: () => {
      return true;
    },
  };
}

const proc = makeProc();

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      browser: {
        enabled: true,
        evaluateEnabled: cfgEvaluateEnabled,
        color: "#FF4500",
        attachOnly: cfgAttachOnly,
        headless: true,
        defaultProfile: "clawd",
        profiles: {
          clawd: { cdpPort: testPort + 1, color: "#FF4500" },
        },
      },
    }),
    writeConfigFile: vi.fn(async () => {}),
  };
});

const launchCalls = vi.hoisted(() => [] as Array<{ port: number }>);
vi.mock("./chrome.js", () => ({
  isChromeCdpReady: vi.fn(async () => reachable),
  isChromeReachable: vi.fn(async () => reachable),
  launchClawdChrome: vi.fn(async (_resolved: unknown, profile: { cdpPort: number }) => {
    launchCalls.push({ port: profile.cdpPort });
    reachable = true;
    return {
      pid: 123,
      exe: { kind: "chrome", path: "/fake/chrome" },
      userDataDir: "/tmp/clawd",
      cdpPort: profile.cdpPort,
      startedAt: Date.now(),
      proc,
    };
  }),
  resolveClawdUserDataDir: vi.fn(() => "/tmp/clawd"),
  stopClawdChrome: vi.fn(async () => {
    reachable = false;
  }),
}));

vi.mock("./cdp.js", () => ({
  createTargetViaCdp: cdpMocks.createTargetViaCdp,
  normalizeCdpWsUrl: vi.fn((wsUrl: string) => wsUrl),
  snapshotAria: cdpMocks.snapshotAria,
  getHeadersWithAuth: vi.fn(() => ({})),
  appendCdpPath: vi.fn((cdpUrl: string, path: string) => {
    const base = cdpUrl.replace(/\/$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${base}${suffix}`;
  }),
}));

vi.mock("./pw-ai.js", () => pwMocks);

vi.mock("../media/store.js", () => ({
  ensureMediaDir: vi.fn(async () => {}),
  saveMediaBuffer: vi.fn(async () => ({ path: "/tmp/fake.png" })),
}));

vi.mock("./screenshot.js", () => ({
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES: 128,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE: 64,
  normalizeBrowserScreenshot: vi.fn(async (buf: Buffer) => ({
    buffer: buf,
    contentType: "image/png",
  })),
}));

async function getFreePort(): Promise<number> {
  while (true) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const assigned = (s.address() as AddressInfo).port;
        s.close((err) => (err ? reject(err) : resolve(assigned)));
      });
    });
    if (port < 65535) return port;
  }
}

function makeResponse(
  body: unknown,
  init?: { ok?: boolean; status?: number; text?: string },
): Response {
  const ok = init?.ok ?? true;
  const status = init?.status ?? 200;
  const text = init?.text ?? "";
  return {
    ok,
    status,
    json: async () => body,
    text: async () => text,
  } as unknown as Response;
}

describe("browser control server", () => {
  beforeEach(async () => {
    reachable = false;
    cfgAttachOnly = false;
    cfgEvaluateEnabled = true;
    createTargetId = null;

    cdpMocks.createTargetViaCdp.mockImplementation(async () => {
      if (createTargetId) return { targetId: createTargetId };
      throw new Error("cdp disabled");
    });

    for (const fn of Object.values(pwMocks)) fn.mockClear();
    for (const fn of Object.values(cdpMocks)) fn.mockClear();

    testPort = await getFreePort();
    cdpBaseUrl = `http://127.0.0.1:${testPort + 1}`;
    prevGatewayPort = process.env.CLAWDBOT_GATEWAY_PORT;
    process.env.CLAWDBOT_GATEWAY_PORT = String(testPort - 2);

    // Minimal CDP JSON endpoints used by the server.
    let putNewCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/json/list")) {
          if (!reachable) return makeResponse([]);
          return makeResponse([
            {
              id: "abcd1234",
              title: "Tab",
              url: "https://example.com",
              webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/abcd1234",
              type: "page",
            },
            {
              id: "abce9999",
              title: "Other",
              url: "https://other",
              webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/abce9999",
              type: "page",
            },
          ]);
        }
        if (u.includes("/json/new?")) {
          if (init?.method === "PUT") {
            putNewCalls += 1;
            if (putNewCalls === 1) {
              return makeResponse({}, { ok: false, status: 405, text: "" });
            }
          }
          return makeResponse({
            id: "newtab1",
            title: "",
            url: "about:blank",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/newtab1",
            type: "page",
          });
        }
        if (u.includes("/json/activate/")) return makeResponse("ok");
        if (u.includes("/json/close/")) return makeResponse("ok");
        return makeResponse({}, { ok: false, status: 500, text: "unexpected" });
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (prevGatewayPort === undefined) {
      delete process.env.CLAWDBOT_GATEWAY_PORT;
    } else {
      process.env.CLAWDBOT_GATEWAY_PORT = prevGatewayPort;
    }
    const { stopBrowserControlServer } = await import("./server.js");
    await stopBrowserControlServer();
  });

  const startServerAndBase = async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;
    await realFetch(`${base}/start`, { method: "POST" }).then((r) => r.json());
    return base;
  };

  const postJson = async <T>(url: string, body?: unknown): Promise<T> => {
    const res = await realFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await res.json()) as T;
  };

  const slowTimeoutMs = process.platform === "win32" ? 40_000 : 20_000;

  it(
    "agent contract: form + layout act commands",
    async () => {
      const base = await startServerAndBase();

      const select = (await postJson(`${base}/act`, {
        kind: "select",
        ref: "5",
        values: ["a", "b"],
      })) as { ok: boolean };
      expect(select.ok).toBe(true);
      expect(pwMocks.selectOptionViaPlaywright).toHaveBeenCalledWith({
        cdpUrl: cdpBaseUrl,
        targetId: "abcd1234",
        ref: "5",
        values: ["a", "b"],
      });

      const fill = (await postJson(`${base}/act`, {
        kind: "fill",
        fields: [{ ref: "6", type: "textbox", value: "hello" }],
      })) as { ok: boolean };
      expect(fill.ok).toBe(true);
      expect(pwMocks.fillFormViaPlaywright).toHaveBeenCalledWith({
        cdpUrl: cdpBaseUrl,
        targetId: "abcd1234",
        fields: [{ ref: "6", type: "textbox", value: "hello" }],
      });

      const resize = (await postJson(`${base}/act`, {
        kind: "resize",
        width: 800,
        height: 600,
      })) as { ok: boolean };
      expect(resize.ok).toBe(true);
      expect(pwMocks.resizeViewportViaPlaywright).toHaveBeenCalledWith({
        cdpUrl: cdpBaseUrl,
        targetId: "abcd1234",
        width: 800,
        height: 600,
      });

      const wait = (await postJson(`${base}/act`, {
        kind: "wait",
        timeMs: 5,
      })) as { ok: boolean };
      expect(wait.ok).toBe(true);
      expect(pwMocks.waitForViaPlaywright).toHaveBeenCalledWith({
        cdpUrl: cdpBaseUrl,
        targetId: "abcd1234",
        timeMs: 5,
        text: undefined,
        textGone: undefined,
      });

      const evalRes = (await postJson(`${base}/act`, {
        kind: "evaluate",
        fn: "() => 1",
      })) as { ok: boolean; result?: unknown };
      expect(evalRes.ok).toBe(true);
      expect(evalRes.result).toBe("ok");
      expect(pwMocks.evaluateViaPlaywright).toHaveBeenCalledWith({
        cdpUrl: cdpBaseUrl,
        targetId: "abcd1234",
        fn: "() => 1",
        ref: undefined,
      });
    },
    slowTimeoutMs,
  );

  it(
    "blocks act:evaluate when browser.evaluateEnabled=false",
    async () => {
      cfgEvaluateEnabled = false;
      const base = await startServerAndBase();

      const waitRes = (await postJson(`${base}/act`, {
        kind: "wait",
        fn: "() => window.ready === true",
      })) as { error?: string };
      expect(waitRes.error).toContain("browser.evaluateEnabled=false");
      expect(pwMocks.waitForViaPlaywright).not.toHaveBeenCalled();

      const res = (await postJson(`${base}/act`, {
        kind: "evaluate",
        fn: "() => 1",
      })) as { error?: string };

      expect(res.error).toContain("browser.evaluateEnabled=false");
      expect(pwMocks.evaluateViaPlaywright).not.toHaveBeenCalled();
    },
    slowTimeoutMs,
  );

  it("agent contract: hooks + response + downloads + screenshot", async () => {
    const base = await startServerAndBase();

    const upload = await postJson(`${base}/hooks/file-chooser`, {
      paths: ["/tmp/a.txt"],
      timeoutMs: 1234,
    });
    expect(upload).toMatchObject({ ok: true });
    expect(pwMocks.armFileUploadViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      paths: ["/tmp/a.txt"],
      timeoutMs: 1234,
    });

    const uploadWithRef = await postJson(`${base}/hooks/file-chooser`, {
      paths: ["/tmp/b.txt"],
      ref: "e12",
    });
    expect(uploadWithRef).toMatchObject({ ok: true });

    const uploadWithInputRef = await postJson(`${base}/hooks/file-chooser`, {
      paths: ["/tmp/c.txt"],
      inputRef: "e99",
    });
    expect(uploadWithInputRef).toMatchObject({ ok: true });

    const uploadWithElement = await postJson(`${base}/hooks/file-chooser`, {
      paths: ["/tmp/d.txt"],
      element: "input[type=file]",
    });
    expect(uploadWithElement).toMatchObject({ ok: true });

    const dialog = await postJson(`${base}/hooks/dialog`, {
      accept: true,
      timeoutMs: 5678,
    });
    expect(dialog).toMatchObject({ ok: true });

    const waitDownload = await postJson(`${base}/wait/download`, {
      path: "/tmp/report.pdf",
      timeoutMs: 1111,
    });
    expect(waitDownload).toMatchObject({ ok: true });

    const download = await postJson(`${base}/download`, {
      ref: "e12",
      path: "/tmp/report.pdf",
    });
    expect(download).toMatchObject({ ok: true });

    const responseBody = await postJson(`${base}/response/body`, {
      url: "**/api/data",
      timeoutMs: 2222,
      maxChars: 10,
    });
    expect(responseBody).toMatchObject({ ok: true });

    const consoleRes = (await realFetch(`${base}/console?level=error`).then((r) => r.json())) as {
      ok: boolean;
      messages?: unknown[];
    };
    expect(consoleRes.ok).toBe(true);
    expect(Array.isArray(consoleRes.messages)).toBe(true);

    const pdf = (await postJson(`${base}/pdf`, {})) as {
      ok: boolean;
      path?: string;
    };
    expect(pdf.ok).toBe(true);
    expect(typeof pdf.path).toBe("string");

    const shot = (await postJson(`${base}/screenshot`, {
      element: "body",
      type: "jpeg",
    })) as { ok: boolean; path?: string };
    expect(shot.ok).toBe(true);
    expect(typeof shot.path).toBe("string");
  });

  it("agent contract: stop endpoint", async () => {
    const base = await startServerAndBase();

    const stopped = (await realFetch(`${base}/stop`, {
      method: "POST",
    }).then((r) => r.json())) as { ok: boolean; stopped?: boolean };
    expect(stopped.ok).toBe(true);
    expect(stopped.stopped).toBe(true);
  });
});
