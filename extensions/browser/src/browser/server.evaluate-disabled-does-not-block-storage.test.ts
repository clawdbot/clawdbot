import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFreePort } from "./test-port.js";
import { getBrowserTestFetch } from "./test-support/fetch.js";

let testPort = 0;
let prevGatewayPort: string | undefined;
let prevGatewayToken: string | undefined;
let prevGatewayPassword: string | undefined;

const pwMocks = vi.hoisted(() => ({
  cookiesGetViaPlaywright: vi.fn(async () => ({
    cookies: [{ name: "session", value: "abc123" }],
  })),
  storageGetViaPlaywright: vi.fn(async () => ({ values: { token: "value" } })),
  evaluateViaPlaywright: vi.fn(async () => "ok"),
}));

const routeCtxMocks = vi.hoisted(() => {
  const profileCtx = {
    profile: { cdpUrl: "http://127.0.0.1:9222" },
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "tab-1",
      url: "https://example.com",
    })),
    stopRunningBrowser: vi.fn(async () => {}),
  };

  return {
    profileCtx,
    createBrowserRouteContext: vi.fn(() => ({
      state: () => ({ resolved: { evaluateEnabled: false } }),
      forProfile: vi.fn(() => profileCtx),
      mapTabError: vi.fn(() => null),
    })),
  };
});

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  const loadConfig = () => ({
    browser: {
      enabled: true,
      evaluateEnabled: false,
      defaultProfile: "openclaw",
      profiles: {
        openclaw: { cdpPort: testPort + 1, color: "#FF4500" },
      },
    },
  });
  return {
    ...actual,
    getRuntimeConfig: loadConfig,
    loadConfig,
    writeConfigFile: vi.fn(async () => {}),
  };
});

vi.mock("./pw-ai-module.js", () => ({
  getPwAiModule: vi.fn(async () => pwMocks),
}));

vi.mock("./server-context.js", async () => {
  const actual = await vi.importActual<typeof import("./server-context.js")>("./server-context.js");
  return {
    ...actual,
    createBrowserRouteContext: routeCtxMocks.createBrowserRouteContext,
  };
});

const { startBrowserControlServerFromConfig, stopBrowserControlServer } =
  await import("../server.js");

describe("browser control evaluate gating", () => {
  beforeEach(async () => {
    testPort = await getFreePort();
    prevGatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
    process.env.OPENCLAW_GATEWAY_PORT = String(testPort - 2);
    prevGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    prevGatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;

    pwMocks.cookiesGetViaPlaywright.mockClear();
    pwMocks.storageGetViaPlaywright.mockClear();
    pwMocks.evaluateViaPlaywright.mockClear();
    routeCtxMocks.profileCtx.ensureTabAvailable.mockClear();
    routeCtxMocks.profileCtx.stopRunningBrowser.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (prevGatewayPort === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PORT;
    } else {
      process.env.OPENCLAW_GATEWAY_PORT = prevGatewayPort;
    }
    if (prevGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = prevGatewayToken;
    }
    if (prevGatewayPassword === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    } else {
      process.env.OPENCLAW_GATEWAY_PASSWORD = prevGatewayPassword;
    }

    await stopBrowserControlServer();
  });

  it("blocks act:evaluate but still allows cookies/storage reads", async () => {
    await startBrowserControlServerFromConfig();
    const realFetch = getBrowserTestFetch();

    const base = `http://127.0.0.1:${testPort}`;

    const evalRes = (await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "evaluate", fn: "() => 1" }),
    }).then((r) => r.json())) as { error?: string };

    expect(evalRes.error).toContain("browser.evaluateEnabled=false");
    expect(pwMocks.evaluateViaPlaywright).not.toHaveBeenCalled();

    const cookiesRes = (await realFetch(`${base}/cookies`).then((r) => r.json())) as {
      ok: boolean;
      cookies?: Array<{ name: string }>;
    };
    expect(cookiesRes.ok).toBe(true);
    expect(cookiesRes.cookies?.[0]?.name).toBe("session");
    expect(pwMocks.cookiesGetViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
    });

    const storageRes = (await realFetch(`${base}/storage/local?key=token`).then((r) =>
      r.json(),
    )) as {
      ok: boolean;
      values?: Record<string, string>;
    };
    expect(storageRes.ok).toBe(true);
    expect(storageRes.values).toEqual({ token: "value" });
    expect(pwMocks.storageGetViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      kind: "local",
      key: "token",
    });
  });
});
