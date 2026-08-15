// Control UI tests prove the global web-search kill switch against a real Gateway.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getFreeGatewayPort,
} from "../../../src/gateway/test-helpers.e2e.js";
import { waitForActiveGatewayRootWork } from "../../../src/process/gateway-work-admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.resolve(
  process.cwd(),
  process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim() ||
    ".artifacts/control-ui-e2e/websearch-kill-switch",
);
const viewport = { height: 900, width: 1280 };
const authToken = "websearch-kill-switch-token";
const controlUiSettleTimeoutMs = 60_000;

type RealGateway = {
  cleanup: () => Promise<void>;
  port: number;
  server: GatewayServer;
  state: OpenClawTestState;
  url: string;
};

type GatewayFrameEvidence = {
  methods: string[];
  sessionPatchCount: number;
};

let browser: Browser;
let ui: ControlUiE2eServer;
let gateway: RealGateway;
const openContexts = new Set<BrowserContext>();

function requestMethodFromFrame(payload: string): string | null {
  try {
    const parsed = asRecord(JSON.parse(payload));
    if (parsed?.type !== "req" || typeof parsed.method !== "string") {
      return null;
    }
    return parsed.method;
  } catch {
    return null;
  }
}

function attachGatewayFrameCollector(page: Page): GatewayFrameEvidence {
  const evidence: GatewayFrameEvidence = { methods: [], sessionPatchCount: 0 };
  page.on("websocket", (socket) => {
    socket.on("framesent", (frame) => {
      if (typeof frame.payload !== "string") {
        return;
      }
      const method = requestMethodFromFrame(frame.payload);
      if (!method) {
        return;
      }
      evidence.methods.push(method);
      if (method === "sessions.patch") {
        evidence.sessionPatchCount += 1;
      }
    });
  });
  return evidence;
}

function isolatedGatewayPath(): string {
  return [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter);
}

async function startRealGateway(allowedOrigin: string): Promise<RealGateway> {
  const port = await getFreeGatewayPort();
  const state = await createOpenClawTestState({
    label: "websearch-kill-switch",
    layout: "home",
    env: {
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: authToken,
      OPENCLAW_PATH_BOOTSTRAPPED: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      PATH: isolatedGatewayPath(),
      VITEST: "1",
    },
  });
  // Avoid openai/* so models.authStatus does not import OS-user ~/.codex
  // (Codex home is not OPENCLAW_HOME). That probe serializes config.get
  // for minutes, and the composer never appears.
  const modelRef = "test/model";
  await state.writeConfig({
    agents: {
      defaults: {
        model: { primary: modelRef },
        models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
        workspace: state.workspaceDir,
      },
      list: [
        {
          default: true,
          id: "main",
          model: { primary: modelRef },
          workspace: state.workspaceDir,
        },
      ],
    },
    gateway: {
      auth: {
        mode: "token",
        token: authToken,
      },
      controlUi: {
        allowedOrigins: [allowedOrigin],
        enabled: false,
      },
      port,
    },
    models: {
      catalogRefresh: { enabled: false },
    },
    tools: {
      web: {
        search: { enabled: false },
      },
    },
  });
  state.applyEnv();
  let server: GatewayServer | undefined;
  try {
    const { startGatewayServer } = await import("../../../src/gateway/server.js");
    server = await startGatewayServer(port, {
      auth: {
        mode: "token",
        token: authToken,
      },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    const seedClient = await connectGatewayClient({
      clientDisplayName: "websearch-kill-switch-seed",
      scopes: ["operator.read", "operator.write"],
      token: authToken,
      url: `ws://127.0.0.1:${port}`,
    });
    try {
      // Capability menu stays on "Loading…" until a session row exists.
      await seedClient.request("sessions.create", { agentId: "main", key: "main" });
    } finally {
      await disconnectGatewayClient(seedClient);
    }
    const started = server;
    return {
      cleanup: async () => {
        await started.close({ reason: "websearch kill switch test cleanup" });
        await state.cleanup();
      },
      port,
      server: started,
      state,
      url: `ws://127.0.0.1:${port}`,
    };
  } catch (error) {
    await server?.close({ reason: "websearch kill switch test startup failure" }).catch(() => {});
    await state.cleanup();
    throw error;
  }
}

function chatUrlWithGateway(baseUrl: string, gatewayUrl: string): string {
  const url = new URL("chat", baseUrl);
  url.searchParams.set("gatewayUrl", gatewayUrl);
  url.hash = `token=${encodeURIComponent(authToken)}`;
  return url.toString();
}

async function openCapabilityMenu(page: Page) {
  const composer = page.locator(".agent-chat__input");
  const dropdown = composer.locator("wa-dropdown.agent-chat__capability-menu");
  const skills = composer.getByRole("menuitem", { name: "Skills" });
  const isOpen = await dropdown.evaluate((node) => (node as HTMLElement & { open: boolean }).open);
  if (!isOpen) {
    await composer.getByRole("button", { name: "Add attachment" }).click();
  }
  await expect
    .poll(async () => {
      const open = await dropdown.evaluate(
        (node) => (node as HTMLElement & { open: boolean }).open,
      );
      return open && (await skills.isVisible());
    })
    .toBe(true);
  return composer;
}

async function captureChromiumScreenshot(page: Page, fileName: string): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(artifactDir, { recursive: true });
  const session = await page.context().newCDPSession(page);
  try {
    const result = await session.send("Page.captureScreenshot", {
      captureBeyondViewport: false,
      format: "png",
      fromSurface: true,
    });
    await writeFile(path.join(artifactDir, fileName), Buffer.from(result.data, "base64"));
  } finally {
    await session.detach();
  }
}

describeControlUiE2e("Control UI web-search kill switch against a real Gateway", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}.`,
      );
    }
    await mkdir(artifactDir, { recursive: true });
    ui = await startControlUiE2eServer();
    gateway = await startRealGateway(new URL(ui.baseUrl).origin);
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    openContexts.clear();
    const cleanupResults = await Promise.allSettled([
      browser?.close(),
      gateway?.cleanup(),
      ui?.close(),
    ]);
    expect(
      cleanupResults
        .filter((result) => result.status === "rejected")
        .map((result) => String(result.reason)),
    ).toEqual([]);
  }, 30_000);

  afterEach(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    openContexts.clear();
  });

  it("disables turning web search on when tools.web.search.enabled is false", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      permissions: ["local-network-access"],
      recordVideo: captureUiProofEnabled ? { dir: artifactDir, size: viewport } : undefined,
      serviceWorkers: "block",
      viewport,
    });
    openContexts.add(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const frames = attachGatewayFrameCollector(page);
    const response = await page.goto(chatUrlWithGateway(ui.baseUrl, gateway.url), {
      timeout: controlUiSettleTimeoutMs,
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);
    const confirmation = page.locator("openclaw-gateway-url-confirmation");
    await confirmation.waitFor({ timeout: controlUiSettleTimeoutMs });
    expect(await confirmation.textContent()).toContain(gateway.url);
    await confirmation
      .getByRole("button", { name: "Confirm", exact: true })
      .click({ timeout: controlUiSettleTimeoutMs });
    await page.locator("openclaw-app-shell").waitFor({ timeout: controlUiSettleTimeoutMs });
    const composerLocator = page.locator(".agent-chat__input");
    const modelSetupGate = page.getByRole("heading", { name: "No AI provider configured" });
    try {
      await Promise.race([
        composerLocator.waitFor({ timeout: controlUiSettleTimeoutMs }),
        modelSetupGate.waitFor({ timeout: controlUiSettleTimeoutMs }).then(async () => {
          throw new Error(
            `chat composer was replaced by the model-setup gate; agents.defaults.model did not reach the UI (${await modelSetupGate.textContent()})`,
          );
        }),
      ]);
    } catch (error) {
      throw new Error(
        `chat composer did not appear; gateway methods=${frames.methods.join(",") || "(none)"}: ${String(error)}`,
      );
    }

    const composer = await openCapabilityMenu(page);
    const menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
    const webSearch = menu.getByRole("menuitemcheckbox", { name: "Web search" });
    await expect.poll(() => webSearch.isDisabled()).toBe(true);
    await expect
      .poll(() => webSearch.getAttribute("title"), { timeout: 45_000 })
      .toContain("tools.web.search.enabled");
    await captureChromiumScreenshot(page, "01-websearch-globally-disabled.png");

    const sessionPatchCountBeforeSelect = frames.sessionPatchCount;
    await webSearch.evaluate((item) => {
      item
        .closest("wa-dropdown")
        ?.dispatchEvent(new CustomEvent("wa-select", { bubbles: true, detail: { item } }));
    });
    await expect.poll(() => frames.methods.includes("config.get")).toBe(true);
    expect(frames.sessionPatchCount).toBe(sessionPatchCountBeforeSelect);

    if (captureUiProofEnabled) {
      await writeFile(
        path.join(artifactDir, "gateway-request-trace.json"),
        `${JSON.stringify(
          {
            gatewayUrl: gateway.url,
            methods: frames.methods,
            sessionPatchCount: frames.sessionPatchCount,
            toolsWebSearchEnabled: false,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    }

    await context.close();
    openContexts.delete(context);
    await expect(waitForActiveGatewayRootWork()).resolves.toEqual({ active: 0, drained: true });
  }, 180_000);
});
