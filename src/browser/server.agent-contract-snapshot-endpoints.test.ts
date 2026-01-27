import { type AddressInfo, createServer } from "node:net";
import { fetch as realFetch } from "undici";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "./constants.js";

let testPort = 0;
let cdpBaseUrl = "";
let reachable = false;
let cfgAttachOnly = false;
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

  it("agent contract: snapshot endpoints", async () => {
    const base = await startServerAndBase();

    const snapAria = (await realFetch(`${base}/snapshot?format=aria&limit=1`).then((r) =>
      r.json(),
    )) as { ok: boolean; format?: string };
    expect(snapAria.ok).toBe(true);
    expect(snapAria.format).toBe("aria");
    expect(cdpMocks.snapshotAria).toHaveBeenCalledWith({
      wsUrl: "ws://127.0.0.1/devtools/page/abcd1234",
      limit: 1,
    });

    const snapAi = (await realFetch(`${base}/snapshot?format=ai`).then((r) => r.json())) as {
      ok: boolean;
      format?: string;
    };
    expect(snapAi.ok).toBe(true);
    expect(snapAi.format).toBe("ai");
    expect(pwMocks.snapshotAiViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      maxChars: DEFAULT_AI_SNAPSHOT_MAX_CHARS,
    });
  });

  it("agent contract: navigation + common act commands", async () => {
    const base = await startServerAndBase();

    const nav = (await postJson(`${base}/navigate`, {
      url: "https://example.com",
    })) as { ok: boolean; targetId?: string };
    expect(nav.ok).toBe(true);
    expect(typeof nav.targetId).toBe("string");
    expect(pwMocks.navigateViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      url: "https://example.com",
    });

    const click = (await postJson(`${base}/act`, {
      kind: "click",
      ref: "1",
      button: "left",
      modifiers: ["Shift"],
    })) as { ok: boolean };
    expect(click.ok).toBe(true);
    expect(pwMocks.clickViaPlaywright).toHaveBeenNthCalledWith(1, {
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      ref: "1",
      doubleClick: false,
      button: "left",
      modifiers: ["Shift"],
    });

    const clickSelector = await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "click", selector: "button.save" }),
    });
    expect(clickSelector.status).toBe(400);
    expect(((await clickSelector.json()) as { error?: string }).error).toMatch(
      /'selector' is not supported/i,
    );

    const type = (await postJson(`${base}/act`, {
      kind: "type",
      ref: "1",
      text: "",
    })) as { ok: boolean };
    expect(type.ok).toBe(true);
    expect(pwMocks.typeViaPlaywright).toHaveBeenNthCalledWith(1, {
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      ref: "1",
      text: "",
      submit: false,
      slowly: false,
    });

    const press = (await postJson(`${base}/act`, {
      kind: "press",
      key: "Enter",
    })) as { ok: boolean };
    expect(press.ok).toBe(true);
    expect(pwMocks.pressKeyViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      key: "Enter",
    });

    const hover = (await postJson(`${base}/act`, {
      kind: "hover",
      ref: "2",
    })) as { ok: boolean };
    expect(hover.ok).toBe(true);
    expect(pwMocks.hoverViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      ref: "2",
    });

    const scroll = (await postJson(`${base}/act`, {
      kind: "scrollIntoView",
      ref: "2",
    })) as { ok: boolean };
    expect(scroll.ok).toBe(true);
    expect(pwMocks.scrollIntoViewViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      ref: "2",
    });

    const drag = (await postJson(`${base}/act`, {
      kind: "drag",
      startRef: "3",
      endRef: "4",
    })) as { ok: boolean };
    expect(drag.ok).toBe(true);
    expect(pwMocks.dragViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      startRef: "3",
      endRef: "4",
    });
  });
});
