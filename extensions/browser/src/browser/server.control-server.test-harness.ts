import { afterEach, beforeEach, vi } from "vitest";
import { deriveDefaultBrowserCdpPortRange } from "../config/port-defaults.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import { installChromeUserDataDirHooks } from "./chrome-user-data-dir.test-harness.js";
import { getFreePort } from "./test-port.js";

export { getFreePort } from "./test-port.js";

type HarnessState = {
  testPort: number;
  cdpBaseUrl: string;
  reachable: boolean;
  cfgAttachOnly: boolean;
  cfgEvaluateEnabled: boolean;
  cfgDefaultProfile: string;
  cfgProfiles: Record<
    string,
    {
      cdpPort?: number;
      cdpUrl?: string;
      color: string;
      driver?: "openclaw" | "existing-session";
      attachOnly?: boolean;
    }
  >;
  createTargetId: string | null;
  prevGatewayPort: string | undefined;
  prevGatewayToken: string | undefined;
  prevGatewayPassword: string | undefined;
};

const state: HarnessState = {
  testPort: 0,
  cdpBaseUrl: "",
  reachable: false,
  cfgAttachOnly: false,
  cfgEvaluateEnabled: true,
  cfgDefaultProfile: "openclaw",
  cfgProfiles: {},
  createTargetId: null,
  prevGatewayPort: undefined,
  prevGatewayToken: undefined,
  prevGatewayPassword: undefined,
};

export function getBrowserControlServerTestState(): HarnessState {
  return state;
}

export function getBrowserControlServerBaseUrl(): string {
  return `http://127.0.0.1:${state.testPort}`;
}

export function restoreGatewayPortEnv(prevGatewayPort: string | undefined): void {
  if (prevGatewayPort === undefined) {
    delete process.env.OPENCLAW_GATEWAY_PORT;
    return;
  }
  process.env.OPENCLAW_GATEWAY_PORT = prevGatewayPort;
}

export function setBrowserControlServerCreateTargetId(targetId: string | null): void {
  state.createTargetId = targetId;
}

export function setBrowserControlServerAttachOnly(attachOnly: boolean): void {
  state.cfgAttachOnly = attachOnly;
}

export function setBrowserControlServerEvaluateEnabled(enabled: boolean): void {
  state.cfgEvaluateEnabled = enabled;
}

export function setBrowserControlServerReachable(reachable: boolean): void {
  state.reachable = reachable;
}

export function setBrowserControlServerProfiles(
  profiles: HarnessState["cfgProfiles"],
  defaultProfile = Object.keys(profiles)[0] ?? "openclaw",
): void {
  state.cfgProfiles = profiles;
  state.cfgDefaultProfile = defaultProfile;
}

const cdpMocks = vi.hoisted(() => ({
  createTargetViaCdp: vi.fn<() => Promise<{ targetId: string }>>(async () => {
    throw new Error("cdp disabled");
  }),
  snapshotAria: vi.fn(async () => ({
    nodes: [{ ref: "1", role: "link", name: "x", depth: 0 }],
  })),
  snapshotRoleViaCdp: vi.fn(async () => ({
    snapshot: '- button "Fallback" [ref=e1]',
    refs: { e1: { role: "button", name: "Fallback" } },
    stats: { lines: 1, chars: 29, refs: 1, interactive: 1 },
  })),
}));

export function getCdpMocks(): {
  createTargetViaCdp: MockFn;
  snapshotAria: MockFn;
  snapshotRoleViaCdp: MockFn;
} {
  return cdpMocks as unknown as {
    createTargetViaCdp: MockFn;
    snapshotAria: MockFn;
    snapshotRoleViaCdp: MockFn;
  };
}

type ExecuteActMockAction = { kind: string } & Record<string, unknown>;
type ExecuteActMockOptions = {
  cdpUrl: string;
  action: ExecuteActMockAction;
  targetId?: string;
  ssrfPolicy?: unknown;
  evaluateEnabled?: boolean;
  signal?: AbortSignal;
};

type PassThroughActDispatch = {
  mock: (opts?: unknown) => Promise<unknown>;
  fields: readonly string[];
  includeSsrf?: boolean;
  includeSignal?: boolean;
};

function pickActionFields(
  action: ExecuteActMockAction,
  fields: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    picked[field] = action[field];
  }
  return picked;
}

function buildActPayload(params: {
  cdpUrl: string;
  targetId?: string;
  action: ExecuteActMockAction;
  fields: readonly string[];
  ssrfPolicy?: unknown;
  signal?: AbortSignal;
  includeSsrf?: boolean;
  includeSignal?: boolean;
}): Record<string, unknown> {
  return {
    cdpUrl: params.cdpUrl,
    targetId: params.targetId,
    ...pickActionFields(params.action, params.fields),
    ...(params.includeSsrf ? { ssrfPolicy: params.ssrfPolicy } : {}),
    ...(params.includeSignal ? { signal: params.signal } : {}),
  };
}

const pwMocks = vi.hoisted(() => ({
  armDialogViaPlaywright: vi.fn(async () => {}),
  armFileUploadViaPlaywright: vi.fn(async () => {}),
  batchViaPlaywright: vi.fn(async (_opts?: unknown) => ({ results: [] })),
  clickCoordsViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  clickViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  closePageViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  closePlaywrightBrowserConnection: vi.fn(async () => {}),
  downloadViaPlaywright: vi.fn(async () => ({
    url: "https://example.com/report.pdf",
    suggestedFilename: "report.pdf",
    path: "/tmp/report.pdf",
  })),
  dragViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  evaluateViaPlaywright: vi.fn(async (_opts?: unknown) => "ok"),
  fillFormViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  getConsoleMessagesViaPlaywright: vi.fn(async () => []),
  hoverViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  scrollIntoViewViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  navigateViaPlaywright: vi.fn(async () => ({ url: "https://example.com" })),
  pdfViaPlaywright: vi.fn(async () => ({ buffer: Buffer.from("pdf") })),
  pressKeyViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  responseBodyViaPlaywright: vi.fn(async () => ({
    url: "https://example.com/api/data",
    status: 200,
    headers: { "content-type": "application/json" },
    body: '{"ok":true}',
  })),
  resizeViewportViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  selectOptionViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  setInputFilesViaPlaywright: vi.fn(async () => {}),
  snapshotAiViaPlaywright: vi.fn(async () => ({ snapshot: "ok" })),
  snapshotRoleViaPlaywright: vi.fn(async () => ({
    snapshot: '- button "Role" [ref=e1]',
    refs: { e1: { role: "button", name: "Role" } },
    stats: { lines: 1, chars: 24, refs: 1, interactive: 1 },
  })),
  storeAriaSnapshotRefsViaPlaywright: vi.fn(async () => {}),
  traceStopViaPlaywright: vi.fn(async () => {}),
  takeScreenshotViaPlaywright: vi.fn(async () => ({
    buffer: Buffer.from("png"),
  })),
  typeViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  waitForDownloadViaPlaywright: vi.fn(async () => ({
    url: "https://example.com/report.pdf",
    suggestedFilename: "report.pdf",
    path: "/tmp/report.pdf",
  })),
  waitForViaPlaywright: vi.fn(async (_opts?: unknown) => {}),
  executeActViaPlaywright: vi.fn(async (_opts?: ExecuteActMockOptions) => ({})),
}));

const passThroughActDispatch: Record<string, PassThroughActDispatch> = {
  click: {
    mock: pwMocks.clickViaPlaywright,
    fields: ["ref", "selector", "doubleClick", "button", "modifiers", "delayMs", "timeoutMs"],
    includeSsrf: true,
  },
  clickCoords: {
    mock: pwMocks.clickCoordsViaPlaywright,
    fields: ["x", "y", "doubleClick", "button", "delayMs", "timeoutMs"],
    includeSsrf: true,
  },
  type: {
    mock: pwMocks.typeViaPlaywright,
    fields: ["ref", "selector", "text", "submit", "slowly", "timeoutMs"],
    includeSsrf: true,
  },
  press: {
    mock: pwMocks.pressKeyViaPlaywright,
    fields: ["key", "delayMs"],
    includeSsrf: true,
  },
  hover: {
    mock: pwMocks.hoverViaPlaywright,
    fields: ["ref", "selector", "timeoutMs"],
  },
  scrollIntoView: {
    mock: pwMocks.scrollIntoViewViaPlaywright,
    fields: ["ref", "selector", "timeoutMs"],
  },
  drag: {
    mock: pwMocks.dragViaPlaywright,
    fields: ["startRef", "startSelector", "endRef", "endSelector", "timeoutMs"],
  },
  select: {
    mock: pwMocks.selectOptionViaPlaywright,
    fields: ["ref", "selector", "values", "timeoutMs"],
  },
  fill: {
    mock: pwMocks.fillFormViaPlaywright,
    fields: ["fields", "timeoutMs"],
  },
  resize: {
    mock: pwMocks.resizeViewportViaPlaywright,
    fields: ["width", "height"],
  },
  wait: {
    mock: pwMocks.waitForViaPlaywright,
    fields: ["timeMs", "text", "textGone", "selector", "url", "loadState", "fn", "timeoutMs"],
    includeSignal: true,
  },
  close: {
    mock: pwMocks.closePageViaPlaywright,
    fields: [],
  },
};

pwMocks.executeActViaPlaywright.mockImplementation(
  async (opts: ExecuteActMockOptions | undefined) => {
    if (!opts) {
      return {};
    }
    const { cdpUrl, action, targetId, ssrfPolicy, evaluateEnabled, signal } = opts;
    const spec = passThroughActDispatch[action.kind];
    if (spec) {
      await spec.mock(
        buildActPayload({
          cdpUrl,
          targetId,
          action,
          fields: spec.fields,
          ssrfPolicy,
          signal,
          includeSsrf: spec.includeSsrf,
          includeSignal: spec.includeSignal,
        }),
      );
      return {};
    }

    switch (action.kind) {
      case "evaluate": {
        if (!evaluateEnabled) {
          throw new Error("act:evaluate is disabled by config (browser.evaluateEnabled=false)");
        }
        const result = await pwMocks.evaluateViaPlaywright({
          cdpUrl,
          targetId,
          ssrfPolicy,
          fn: action.fn,
          ref: action.ref,
          timeoutMs: action.timeoutMs,
          signal,
        });
        return { result };
      }
      case "batch": {
        const result = await pwMocks.batchViaPlaywright({
          cdpUrl,
          targetId,
          actions: action.actions,
          stopOnError: action.stopOnError,
          evaluateEnabled,
          ssrfPolicy,
          signal,
        });
        return { results: result.results };
      }
      default:
        return {};
    }
  },
);

export function getPwMocks(): Record<string, MockFn> {
  return pwMocks as unknown as Record<string, MockFn>;
}

const chromeMcpMocks = vi.hoisted(() => ({
  clickChromeMcpCoords: vi.fn(async () => {}),
  clickChromeMcpElement: vi.fn(async () => {}),
  closeChromeMcpSession: vi.fn(async () => true),
  closeChromeMcpTab: vi.fn(async () => {}),
  dragChromeMcpElement: vi.fn(async () => {}),
  ensureChromeMcpAvailable: vi.fn(async () => {}),
  evaluateChromeMcpScript: vi.fn(async () => true),
  fillChromeMcpElement: vi.fn(async () => {}),
  fillChromeMcpForm: vi.fn(async () => {}),
  focusChromeMcpTab: vi.fn(async () => {}),
  getChromeMcpPid: vi.fn(() => 4321),
  hoverChromeMcpElement: vi.fn(async () => {}),
  listChromeMcpTabs: vi.fn(async () => [
    { targetId: "7", title: "", url: "https://example.com", type: "page" },
  ]),
  navigateChromeMcpPage: vi.fn(async ({ url }: { url: string }) => ({ url })),
  openChromeMcpTab: vi.fn(async (_profile: string, url: string) => ({
    targetId: "8",
    title: "",
    url,
    type: "page",
  })),
  pressChromeMcpKey: vi.fn(async () => {}),
  resizeChromeMcpPage: vi.fn(async () => {}),
  takeChromeMcpScreenshot: vi.fn(async () => Buffer.from("png")),
  takeChromeMcpSnapshot: vi.fn(async () => ({
    id: "root",
    role: "document",
    name: "Example",
    children: [{ id: "btn-1", role: "button", name: "Continue" }],
  })),
  uploadChromeMcpFile: vi.fn(async () => {}),
}));

export function getChromeMcpMocks(): Record<string, MockFn> {
  return chromeMcpMocks as unknown as Record<string, MockFn>;
}

const chromeUserDataDir = vi.hoisted(() => ({ dir: "/tmp/openclaw" }));
installChromeUserDataDirHooks(chromeUserDataDir);

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
      for (const cb of handlers.get("exit") ?? []) {
        cb(0);
      }
    },
    kill: () => {
      return true;
    },
  };
}

const proc = makeProc();

function defaultBrowserCdpPortForState(testPort: number): number {
  return deriveDefaultBrowserCdpPortRange(testPort).start;
}

function defaultProfilesForState(testPort: number): HarnessState["cfgProfiles"] {
  return {
    openclaw: { cdpPort: defaultBrowserCdpPortForState(testPort), color: "#FF4500" },
  };
}

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  const loadConfig = () => {
    return {
      browser: {
        enabled: true,
        evaluateEnabled: state.cfgEvaluateEnabled,
        color: "#FF4500",
        attachOnly: state.cfgAttachOnly,
        headless: true,
        defaultProfile: state.cfgDefaultProfile,
        profiles:
          Object.keys(state.cfgProfiles).length > 0
            ? state.cfgProfiles
            : defaultProfilesForState(state.testPort),
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      },
    };
  };
  const writeConfigFile = vi.fn(async () => {});
  return {
    ...actual,
    createConfigIO: vi.fn(() => ({
      loadConfig,
      writeConfigFile,
    })),
    getRuntimeConfigSnapshot: vi.fn(() => null),
    loadConfig,
    writeConfigFile,
  };
});

const launchCalls = vi.hoisted(() => [] as Array<{ port: number }>);

export function getLaunchCalls() {
  return launchCalls;
}

vi.mock("./chrome.js", () => ({
  isChromeCdpReady: vi.fn(async () => state.reachable),
  isChromeReachable: vi.fn(async () => state.reachable),
  launchOpenClawChrome: vi.fn(async (_resolved: unknown, profile: { cdpPort: number }) => {
    launchCalls.push({ port: profile.cdpPort });
    state.reachable = true;
    return {
      pid: 123,
      exe: { kind: "chrome", path: "/fake/chrome" },
      userDataDir: chromeUserDataDir.dir,
      cdpPort: profile.cdpPort,
      startedAt: Date.now(),
      proc,
    };
  }),
  resolveOpenClawUserDataDir: vi.fn(() => chromeUserDataDir.dir),
  stopOpenClawChrome: vi.fn(async () => {
    state.reachable = false;
  }),
}));

vi.mock("./cdp.js", () => ({
  createTargetViaCdp: cdpMocks.createTargetViaCdp,
  normalizeCdpWsUrl: vi.fn((wsUrl: string) => wsUrl),
  snapshotAria: cdpMocks.snapshotAria,
  snapshotRoleViaCdp: cdpMocks.snapshotRoleViaCdp,
  getHeadersWithAuth: vi.fn(() => ({})),
  appendCdpPath: vi.fn((cdpUrl: string, cdpPath: string) => {
    const base = cdpUrl.replace(/\/$/, "");
    const suffix = cdpPath.startsWith("/") ? cdpPath : `/${cdpPath}`;
    return `${base}${suffix}`;
  }),
}));

vi.mock("./pw-ai.js", () => pwMocks);

vi.mock("./chrome-mcp.js", () => chromeMcpMocks);

vi.mock("../media/store.js", () => ({
  MEDIA_MAX_BYTES: 5 * 1024 * 1024,
  ensureMediaDir: vi.fn(async () => {}),
  getMediaDir: vi.fn(() => "/tmp"),
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

let browserServerModulePromise: Promise<typeof import("../server.js")> | undefined;

async function loadBrowserServerModule() {
  browserServerModulePromise ??= import("../server.js");
  return await browserServerModulePromise;
}

export async function startBrowserControlServerFromConfig() {
  return await (await loadBrowserServerModule()).startBrowserControlServerFromConfig();
}

export async function stopBrowserControlServer(): Promise<void> {
  await (await loadBrowserServerModule()).stopBrowserControlServer();
}

export function makeResponse(
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

function mockClearAll(obj: Record<string, { mockClear: () => unknown }>) {
  for (const fn of Object.values(obj)) {
    fn.mockClear();
  }
}

export async function resetBrowserControlServerTestContext(): Promise<void> {
  state.reachable = false;
  state.cfgAttachOnly = false;
  state.cfgEvaluateEnabled = true;
  state.cfgDefaultProfile = "openclaw";
  state.cfgProfiles = defaultProfilesForState(state.testPort);
  state.createTargetId = null;

  mockClearAll(pwMocks);
  mockClearAll(cdpMocks);
  mockClearAll(chromeMcpMocks);

  state.testPort = await getFreePort();
  state.cdpBaseUrl = `http://127.0.0.1:${defaultBrowserCdpPortForState(state.testPort)}`;
  state.cfgProfiles = defaultProfilesForState(state.testPort);
  state.prevGatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
  process.env.OPENCLAW_GATEWAY_PORT = String(state.testPort - 2);
  // Avoid flaky auth coupling: some suites temporarily set gateway env auth
  // which would make the browser control server require auth.
  state.prevGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  state.prevGatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_PASSWORD;
}

export function restoreGatewayAuthEnv(
  prevGatewayToken: string | undefined,
  prevGatewayPassword: string | undefined,
): void {
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
}

export async function cleanupBrowserControlServerTestContext(): Promise<void> {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreGatewayPortEnv(state.prevGatewayPort);
  restoreGatewayAuthEnv(state.prevGatewayToken, state.prevGatewayPassword);
  await stopBrowserControlServer();
}

export function installBrowserControlServerHooks() {
  const hookTimeoutMs = process.platform === "win32" ? 300_000 : 240_000;
  beforeEach(async () => {
    vi.useRealTimers();
    cdpMocks.createTargetViaCdp.mockImplementation(async () => {
      if (state.createTargetId) {
        return { targetId: state.createTargetId };
      }
      throw new Error("cdp disabled");
    });

    await resetBrowserControlServerTestContext();
    // Minimal CDP JSON endpoints used by the server.
    let putNewCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = url;
        if (u.includes("/json/list")) {
          if (!state.reachable) {
            return makeResponse([]);
          }
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
        if (u.includes("/json/activate/")) {
          return makeResponse("ok");
        }
        if (u.includes("/json/close/")) {
          return makeResponse("ok");
        }
        return makeResponse({}, { ok: false, status: 500, text: "unexpected" });
      }),
    );
  }, hookTimeoutMs);

  afterEach(async () => {
    await cleanupBrowserControlServerTestContext();
  });
}
