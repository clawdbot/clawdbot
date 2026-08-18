// Control UI test helper supports control ui e2e setup.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { ConsoleMessage, Frame, Locator, Page, Request } from "playwright";
import type { InlineConfig, Plugin, PreviewServer, ViteDevServer } from "vite";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-contract.js";
import type { ModelCatalogEntry } from "../api/types.ts";
import { normalizeControlUiBuildInfo } from "../build-info-normalizers.ts";
import type { ControlUiBuildInfo } from "../build-info.ts";

export function controlUiSessionPath(sessionKey: string, basePath = ""): string {
  return (
    buildControlUiSessionPath({
      namespace: "chat",
      sessionKey,
      fallbackAgentId: sessionKey.split(":")[1] || "main",
      basePath,
    }) ?? `${basePath}/chat`
  );
}

export function controlUiSessionUrl(baseUrl: string, sessionKey: string): string {
  const url = new URL(baseUrl);
  url.pathname = controlUiSessionPath(sessionKey, url.pathname);
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function navigateToControlUiSession(page: Page, sessionKey: string): Promise<void> {
  await page.evaluate((pathname) => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime?: {
        context: {
          navigate: (routeId: string, options: { pathname: string }) => void;
        };
      };
    };
    if (!app.runtime) {
      throw new Error("OpenClaw application runtime is unavailable");
    }
    app.runtime.context.navigate("chat", { pathname });
  }, controlUiSessionPath(sessionKey));
  await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey));
  await page.waitForFunction(
    (targetSessionKey) =>
      [...document.querySelectorAll<HTMLElement>("openclaw-chat-pane")].some(
        (pane) =>
          pane.classList.contains("chat-pane-cache__pane--visible") &&
          (pane as HTMLElement & { sessionKey?: string }).sessionKey === targetSessionKey,
      ),
    sessionKey,
  );
}

export function controlUiBundledGatewayUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}

export function controlUiBundledSettingsStorageKey(baseUrl: string): string {
  return `openclaw.control.settings.v1:${controlUiBundledGatewayUrl(baseUrl)}`;
}

type ControlUiRouteTarget = {
  hash?: string;
  pathname?: string;
  pathnamePrefix?: string;
  routeId: string;
  search?: string;
};

// Cold Vite route chunks can monopolize Chromium on loaded CI hosts. Keep the
// wait browser-local, but allow enough time for the router to finish committing.
const CONTROL_UI_ROUTE_TIMEOUT_MS = 60_000;

// Loaded CI runners regularly stall real Chromium renders past 10s; the larger
// CI budget trades failure latency, not coverage (mirrors the ui-e2e vitest
// config's expect.poll budget). Local runs keep the snappy 10s deadline.
export const controlUiE2eWaitTimeoutMs =
  process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 30_000 : 10_000;

/**
 * Wait for the browser router to commit a route, not merely update the URL.
 * Browser-local polling keeps readiness independent of host-side CDP scheduling.
 */
export async function waitForControlUiRoute(page: Page, target: ControlUiRouteTarget) {
  try {
    const handle = await page.waitForFunction(
      (expected) => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: {
            router: {
              getState: () => {
                status: string;
                resolvedLocation: { pathname: string } | null;
                matches: { routeId: string }[];
                pendingMatches: unknown[];
              };
            };
          };
        };
        const state = app.runtime?.router.getState();
        const pathname = window.location.pathname;
        return (
          state?.status === "success" &&
          state.matches[0]?.routeId === expected.routeId &&
          state.resolvedLocation?.pathname === pathname &&
          state.pendingMatches.length === 0 &&
          (expected.pathname === undefined || pathname === expected.pathname) &&
          (expected.pathnamePrefix === undefined || pathname.startsWith(expected.pathnamePrefix)) &&
          (expected.search === undefined || window.location.search === expected.search) &&
          (expected.hash === undefined || window.location.hash === expected.hash)
        );
      },
      target,
      { timeout: CONTROL_UI_ROUTE_TIMEOUT_MS },
    );
    await handle.dispose();
  } catch (error) {
    const state = await page.evaluate(() => {
      const app = document.querySelector("openclaw-app") as HTMLElement & {
        runtime?: {
          router: {
            getState: () => unknown;
          };
        };
      };
      return {
        hash: window.location.hash,
        pathname: window.location.pathname,
        router: app.runtime?.router.getState() ?? null,
        search: window.location.search,
      };
    });
    throw new Error(
      `Control UI route did not settle at ${JSON.stringify(target)}; current state: ${JSON.stringify(state)}`,
      { cause: error },
    );
  }
}

/**
 * Wait for the settled in-app confirmation modal. Control UI routes destructive
 * confirms through `showConfirmDialog`, so no native browser dialog ever fires;
 * waiting for full opacity keeps the click from landing mid-animation.
 */
export async function waitForConfirmModal(page: Page): Promise<Locator> {
  await page.waitForFunction(() => {
    const modal = [...document.querySelectorAll("openclaw-modal-dialog")].at(-1);
    const dialog = modal?.shadowRoot
      ?.querySelector("wa-dialog")
      ?.shadowRoot?.querySelector("dialog");
    return Boolean(dialog) && getComputedStyle(dialog as Element).opacity === "1";
  });
  return page.locator("openclaw-modal-dialog").last();
}

export async function waitForControlUiSettingsTakeover(
  page: Page,
  pathname = "/settings/appearance",
): Promise<{ search: Locator; sidebar: Locator }> {
  await waitForControlUiRoute(page, { pathname, routeId: "appearance" });
  const appSidebar = page.locator("openclaw-app-sidebar");
  const sidebar = page.locator(".settings-sidebar");
  const search = sidebar.getByRole("searchbox", { name: "Search settings" });
  await appSidebar.waitFor({ state: "detached" });
  await search.waitFor({ state: "visible" });
  return { search, sidebar };
}

const require = createRequire(import.meta.url);
const json5EsmPath = require.resolve("json5/dist/index.mjs");
const json5BrowserSource = readFileSync(require.resolve("json5/dist/index.min.js"), "utf8");
const commonJsOptimizeDeps = [
  "highlight.js/lib/core",
  "highlight.js/lib/languages/bash",
  "highlight.js/lib/languages/cpp",
  "highlight.js/lib/languages/css",
  "highlight.js/lib/languages/diff",
  "highlight.js/lib/languages/go",
  "highlight.js/lib/languages/java",
  "highlight.js/lib/languages/javascript",
  "highlight.js/lib/languages/json",
  "highlight.js/lib/languages/markdown",
  "highlight.js/lib/languages/python",
  "highlight.js/lib/languages/rust",
  "highlight.js/lib/languages/typescript",
  "highlight.js/lib/languages/xml",
  "highlight.js/lib/languages/yaml",
] as const;

export const defaultControlUiFeatureMethods = [
  "chat.abort",
  "chat.metadata",
  "chat.startup",
  "config.apply",
  "config.patch",
  "config.set",
  "device.scopes.requestUpgrade",
  "device.scopes.waitUpgrade",
  "session.members.add",
  "session.members.list",
  "session.members.remove",
  "session.visibility.set",
  "sessions.abort",
  "sessions.patchMany",
  "sessions.branches.switch",
  "sessions.compact",
  "sessions.compaction.branch",
  "sessions.compaction.restore",
  "sessions.create",
  "sessions.delete",
  "sessions.dispatch",
  "sessions.fork",
  "sessions.groups.delete",
  "sessions.groups.defaults",
  "sessions.groups.list",
  "sessions.groups.put",
  "sessions.groups.rename",
  "sessions.groups.update",
  "sessions.patch",
  "sessions.reclaim",
  "sessions.reset",
  "sessions.rewind",
  "update.hold",
  "update.run",
  "update.status",
  "worktrees.branches",
] as const;

export type MockGatewayRequest = {
  id: string;
  method: string;
  params?: unknown;
};

export type ControlUiMockGatewayScenario = {
  attachmentMaxBytes?: number;
  agentModel?: string | null;
  assistantAgentId?: string;
  assistantName?: string;
  basePath?: string;
  controlUiTabs?: Array<{
    group?: string;
    icon?: string;
    id: string;
    label: string;
    placement?: string;
    pluginId: string;
  }>;
  controlUiWidgetKinds?: Array<{
    kind: string;
    label: string;
    pluginId: string;
  }>;
  allowedSessionVisibilities?: Array<"shared" | "read-only" | "suggest" | "draft">;
  hasMultipleSessionSharingIdentities?: boolean;
  featureCapabilities?: string[];
  defaultAgentId?: string;
  deferredMethods?: string[];
  /** Non-release gateway checkout branch surfaced in the sidebar footer. */
  devGitBranch?: string;
  /** Exact immutable Control UI artifact served by the mocked Gateway. */
  serverBuildId?: string;
  controlUiBuildSource?: "bundled" | "configured";
  serverVersion?: string;
  deviceToken?: string;
  featureMethods?: string[];
  /** Simulate a legacy Gateway that predates the advertised method catalog. */
  omitFeatureMethods?: boolean;
  historyMessages?: unknown[];
  maxPayload?: number;
  /** Static payloads, parameter-matched cases, or call-ordered sequences. */
  methodResponses?: Record<string, unknown>;
  /** URL prefixes that retain the browser's real WebSocket transport. */
  webSocketPassthroughPrefixes?: string[];
  /** Replayed in-flight run snapshot served by chat.history and chat.startup. */
  inFlightRun?: {
    runId: string;
    text?: string;
    startedAt?: number;
    events?: unknown[];
    plan?: unknown;
  } | null;
  /** Online users included in the connect snapshot's presence list. The entry
   * flagged `self` adopts the connecting client's instanceId so presence
   * surfaces (footer facepile, who's-online roster) resolve "you". */
  presenceUsers?: Array<{
    self?: boolean;
    id: string;
    name?: string;
    email?: string;
    avatarUrl?: string;
    watchedSessions?: string[];
  }>;
  /** Subscription-scoped Gateway events replayed on a fixed browser-side cycle. */
  repeatingSessionEvents?: {
    events: Array<{ event: "agent" | "session.observer" | "session.tool"; payload: unknown }>;
    intervalMs?: number;
  };
  /** Session run state served alongside history (hasActiveRun/activeRunIds). */
  sessionInfo?: Record<string, unknown> | null;
  /** Partition sessions.list fixtures by archived state after applying patches. */
  sessionArchiveFiltering?: boolean;
  models?: ModelCatalogEntry[];
  /** Operator scopes returned by the mocked connect handshake. */
  operatorScopes?: string[];
  sessionKey?: string;
  /** Initial gateway-owned custom group catalog (sessions.groups.*), in order. */
  sessionGroups?: string[];
  /** Optional New Session defaults keyed by custom group name. */
  sessionGroupDefaults?: Record<string, { cwd?: string; worktree?: boolean }>;
  terminalEnabled?: boolean;
  cliAgentsEnabled?: boolean;
  workspace?: string;
  workspaceGit?: boolean;
  /** Local media preview roots served in the bootstrap config; tilde sources expand against these. */
  localMediaPreviewRoots?: string[];
};

type NormalizedControlUiMockGatewayScenario = Required<ControlUiMockGatewayScenario>;

const DEFAULT_MOCK_MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_MOCK_ATTACHMENT_MAX_BYTES = Math.floor(
  ((DEFAULT_MOCK_MAX_PAYLOAD_BYTES - 256 * 1024) * 3) / 4,
);

export type ControlUiE2eServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

type ControlUiE2eServerOptions = {
  source?: boolean;
};

const DEFAULT_CONTROL_UI_E2E_BUILD_INFO: ControlUiBuildInfo = {
  version: "2026.7.10",
  commit: "0123456789abcdef0123456789abcdef01234567",
  commitAt: "2026-07-10T11:22:33.000Z",
  builtAt: "2026-07-10T12:34:56.000Z",
  branch: null,
  dirty: false,
  release: false,
  buildId: "e2e",
};

let sharedControlUiE2eServerBaseUrl: string | null = null;

const CONTROL_UI_E2E_DIAGNOSTIC_RING_LIMIT = 200;
const controlUiE2ePageDiagnostics = new WeakMap<Page, ControlUiE2eDiagnosticEvent[]>();
const controlUiE2eUnhandledRejectionPages = new WeakSet<Page>();
let controlUiE2eDiagnosticSequence = 0;

type ControlUiE2eDiagnosticEvent = {
  at: string;
  details: Record<string, unknown>;
  source: "console" | "framenavigated" | "pageerror" | "requestfailed";
};

function installControlUiE2ePageDiagnosticRing(page: Page): ControlUiE2eDiagnosticEvent[] {
  const existing = controlUiE2ePageDiagnostics.get(page);
  if (existing) {
    return existing;
  }
  const events: ControlUiE2eDiagnosticEvent[] = [];
  const push = (event: ControlUiE2eDiagnosticEvent) => {
    events.push(event);
    if (events.length > CONTROL_UI_E2E_DIAGNOSTIC_RING_LIMIT) {
      events.splice(0, events.length - CONTROL_UI_E2E_DIAGNOSTIC_RING_LIMIT);
    }
  };
  const onConsole = (message: ConsoleMessage) => {
    push({
      at: new Date().toISOString(),
      details: {
        location: message.location(),
        text: message.text(),
        type: message.type(),
      },
      source: "console",
    });
  };
  const onPageError = (error: Error) => {
    push({
      at: new Date().toISOString(),
      details: { message: error.message, name: error.name, stack: error.stack ?? null },
      source: "pageerror",
    });
  };
  const onRequestFailed = (request: Request) => {
    push({
      at: new Date().toISOString(),
      details: {
        errorText: request.failure()?.errorText ?? null,
        method: request.method(),
        resourceType: request.resourceType(),
        url: request.url(),
      },
      source: "requestfailed",
    });
  };
  const onFrameNavigated = (frame: Frame) => {
    // Main-frame navigations order boot/reload sequences in failure reports;
    // subframes are noise.
    if (frame !== page.mainFrame()) {
      return;
    }
    push({
      at: new Date().toISOString(),
      details: { url: frame.url() },
      source: "framenavigated",
    });
  };
  page.on("console", onConsole);
  page.on("framenavigated", onFrameNavigated);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  page.once("close", () => {
    page.off("console", onConsole);
    page.off("framenavigated", onFrameNavigated);
    page.off("pageerror", onPageError);
    page.off("requestfailed", onRequestFailed);
    controlUiE2ePageDiagnostics.delete(page);
  });
  controlUiE2ePageDiagnostics.set(page, events);
  return events;
}

async function installControlUiE2eUnhandledRejectionRing(page: Page): Promise<void> {
  if (controlUiE2eUnhandledRejectionPages.has(page)) {
    return;
  }
  controlUiE2eUnhandledRejectionPages.add(page);
  await page.addInitScript(() => {
    const windowWithDiagnostics = window as Window & {
      __OPENCLAW_CONTROL_UI_E2E_UNHANDLED_REJECTIONS__?: Array<{
        at: string;
        reason: unknown;
      }>;
    };
    const events: Array<{ at: string; reason: unknown }> = [];
    windowWithDiagnostics["__OPENCLAW_CONTROL_UI_E2E_UNHANDLED_REJECTIONS__"] = events;
    window.addEventListener("unhandledrejection", (event) => {
      let reason: unknown;
      if (event.reason instanceof Error) {
        reason = {
          message: event.reason.message,
          name: event.reason.name,
          stack: event.reason.stack ?? null,
        };
      } else {
        try {
          reason = structuredClone(event.reason) as unknown;
        } catch {
          reason = String(event.reason);
        }
      }
      events.push({ at: new Date().toISOString(), reason });
      if (events.length > 200) {
        events.splice(0, events.length - 200);
      }
    });
  });
}

export function setSharedControlUiE2eServerBaseUrl(baseUrl: string | null): void {
  sharedControlUiE2eServerBaseUrl = baseUrl;
}

export type MockGatewayControls = {
  closeLatest: (code?: number, reason?: string) => Promise<void>;
  deliverLatest: (frame: unknown) => Promise<void>;
  deferNext: (method: string, match?: Record<string, unknown>) => Promise<void>;
  emitChatFinal: (params: { runId: string; sessionKey?: string; text: string }) => Promise<void>;
  emitGatewayEvent: (event: string, payload?: unknown) => Promise<void>;
  getRequests: (method?: string) => Promise<MockGatewayRequest[]>;
  getSocketCount: () => Promise<number>;
  getSocketUrls: () => Promise<string[]>;
  rejectDeferred: (
    method: string,
    error?: { code?: string; message?: string; details?: unknown; retryable?: boolean },
  ) => Promise<void>;
  resolveDeferred: (method: string, payload?: unknown) => Promise<void>;
  setOnline: (online: boolean) => Promise<void>;
  setServerBuildId: (buildId: string) => Promise<void>;
  setOperatorScopes: (scopes: string[]) => Promise<void>;
  setHistoryMessages: (messages: unknown[]) => Promise<void>;
  setMethodResponse: (method: string, payload: unknown) => Promise<void>;
  setSessionSharingPolicy: (policy: {
    allowedSessionVisibilities: Array<"shared" | "read-only" | "suggest" | "draft">;
    hasMultipleSessionSharingIdentities: boolean;
  }) => Promise<void>;
  /**
   * Resolves with a captured request for `method`. Without `after` this is
   * satisfied by ANY prior request of the method (and returns the latest), so
   * a second same-method wait can return a stale earlier request on slow
   * runners; pass `after` = the pre-action count from `getRequests(method)`
   * to wait for and return the next new request instead.
   */
  waitForRequest: (method: string, options?: { after?: number }) => Promise<MockGatewayRequest>;
};

const chromiumExecutableOverrideEnvKey = "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH";
export const systemChromiumExecutableCandidates = [
  "/snap/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
] as const;

function resolveRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../..");
}

export function resolvePlaywrightChromiumExecutablePath(
  defaultExecutablePath: string,
  env: NodeJS.ProcessEnv = process.env,
  canRun: (chromiumExecutablePath: string) => boolean = canRunPlaywrightChromium,
): string {
  const executableOverride = env[chromiumExecutableOverrideEnvKey]?.trim();
  if (executableOverride) {
    return executableOverride;
  }
  if (canRun(defaultExecutablePath)) {
    return defaultExecutablePath;
  }
  return (
    systemChromiumExecutableCandidates.find((candidate) => canRun(candidate)) ??
    defaultExecutablePath
  );
}

export function canRunPlaywrightChromium(chromiumExecutablePath: string): boolean {
  if (!existsSync(chromiumExecutablePath)) {
    return false;
  }
  return spawnSync(chromiumExecutablePath, ["--version"], { stdio: "ignore" }).status === 0;
}

// Pause an installed virtual clock slightly ahead of its current time so
// elapsed time advances only through clock.runFor/fastForward. Without this,
// page.clock.install() keeps ticking at real-time rate, and slow runners break
// assertions that a virtual deadline has or has not elapsed yet (#115187). The
// headroom keeps the pauseAt target ahead of the still-ticking clock between
// the Date.now() read and the pause; jumping to it fires nothing relevant.
export async function pauseVirtualClock(page: Page): Promise<void> {
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 5_000);
}

export async function startControlUiE2eServer(
  buildInfo?: ControlUiBuildInfo,
  options: ControlUiE2eServerOptions = {},
): Promise<ControlUiE2eServer> {
  // Ordinary E2E files exercise the shipped bundle. Source-module and custom
  // build-info tests retain a private Vite server through the same lease API.
  if (
    sharedControlUiE2eServerBaseUrl !== null &&
    buildInfo === undefined &&
    options.source !== true
  ) {
    return {
      baseUrl: sharedControlUiE2eServerBaseUrl,
      close: async () => {},
    };
  }
  const resolvedBuildInfo = normalizeControlUiBuildInfo(
    buildInfo ?? DEFAULT_CONTROL_UI_E2E_BUILD_INFO,
  );
  // Shared browser fixtures import this helper; load filesystem-bound Vite
  // configuration only when its Node-owned development server actually starts.
  const [
    { createServer },
    { controlUiLocaleModulesPlugin },
    {
      controlUiBrowserOnlySharedModuleAliases,
      resolveExternalPackageAliasesForVite,
      resolveSourcePackageAliasesForVite,
      resolveTsconfigPathAliasesForVite,
    },
  ] = await Promise.all([
    import("vite"),
    import("../../config/control-ui-locales.ts"),
    import("../../vite.config.ts"),
  ]);
  const repoRoot = resolveRepoRoot();
  const uiRoot = path.join(repoRoot, "ui");
  const port = await resolveAvailableLoopbackPort();
  const server = await createServer({
    base: "/",
    cacheDir: path.join(repoRoot, ".artifacts", "control-ui-e2e-vite"),
    clearScreen: false,
    configFile: false,
    define: {
      "globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO": JSON.stringify(resolvedBuildInfo),
    },
    logLevel: "error",
    optimizeDeps: {
      include: [
        "ipaddr.js",
        "lit/directives/repeat.js",
        "markdown-it-task-lists",
        ...commonJsOptimizeDeps,
      ],
    },
    publicDir: path.join(uiRoot, "public"),
    plugins: [controlUiLocaleModulesPlugin(), controlUiBrowserOnlySharedModuleAliases()],
    resolve: {
      alias: [
        { find: "json5", replacement: json5EsmPath },
        ...resolveExternalPackageAliasesForVite(),
        ...resolveSourcePackageAliasesForVite(),
        ...resolveTsconfigPathAliasesForVite(),
      ],
    },
    root: uiRoot,
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
    },
  });
  await server.listen(port);
  return {
    baseUrl: resolveServerBaseUrl(server),
    close: () => server.close(),
  };
}

// Mirror the Gateway's depth-insensitive asset resolution
// (src/gateway/control-ui.ts): any "/assets/" segment serves the bundled
// asset. The built index.html uses portable relative asset URLs, so a
// document reloaded on a deep link like /chat/research requests
// /chat/assets/*.js; without this contract Vite's SPA fallback answers with
// index.html and the module never executes, bricking the page.
function controlUiE2eGatewayAssetPathPlugin(): Plugin {
  return {
    name: "control-ui-e2e-gateway-asset-paths",
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "";
        const assetsIndex = url.indexOf("/assets/");
        if (assetsIndex > 0) {
          req.url = url.slice(assetsIndex);
        }
        next();
      });
    },
  };
}

function controlUiE2ePreviewConfigPlugin(
  bootstrapConfig: Record<string, unknown> = {
    basePath: "/",
    assistantName: "",
    assistantAvatar: "",
  },
): Plugin {
  return {
    name: "control-ui-e2e-preview-config",
    configurePreviewServer(server) {
      server.middlewares.use(CONTROL_UI_BOOTSTRAP_CONFIG_PATH, (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(bootstrapConfig));
      });
    },
  };
}

function createBundledControlUiE2eConfig(
  controlUiViteConfig: (options: { outDir?: string }) => InlineConfig,
  outDir: string,
): InlineConfig {
  const config = controlUiViteConfig({ outDir });
  const uiRoot = path.join(resolveRepoRoot(), "ui");
  return {
    ...config,
    base: "/",
    configFile: false,
    define: {
      ...config.define,
      "globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO": JSON.stringify(
        DEFAULT_CONTROL_UI_E2E_BUILD_INFO,
      ),
    },
    logLevel: "error" as const,
    root: uiRoot,
  };
}

export async function buildProductionControlUiE2e(outDir: string, buildId: string): Promise<void> {
  // Keep the production config outside Vitest, but write directly to the
  // caller-owned output so concurrent E2E builds cannot replace its worker.
  const repoRoot = resolveRepoRoot();
  const uiRoot = path.join(repoRoot, "ui");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    OPENCLAW_CONTROL_UI_BUILD_ID: buildId,
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITEST")) {
      delete env[key];
    }
  }
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), "--production-build", outDir],
    {
      cwd: uiRoot,
      encoding: "utf8",
      env,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Production Control UI build failed (exit ${result.status ?? "unknown"}):\n${result.stderr || result.stdout}`,
    );
  }
}

async function runProductionControlUiBuild(outDir: string): Promise<void> {
  const [{ build }, { default: controlUiViteConfig }] = await Promise.all([
    import("vite"),
    import("../../vite.config.ts"),
  ]);
  await build({
    ...controlUiViteConfig({ outDir }),
    configFile: false,
    logLevel: "error",
    root: path.join(resolveRepoRoot(), "ui"),
  });
}

async function startBuiltControlUiE2eServer(
  outDir: string,
  bootstrapConfig?: Record<string, unknown>,
): Promise<ControlUiE2eServer> {
  const [{ preview }, { default: controlUiViteConfig }] = await Promise.all([
    import("vite"),
    import("../../vite.config.ts"),
  ]);
  const port = await resolveAvailableLoopbackPort();
  const sharedConfig = createBundledControlUiE2eConfig(controlUiViteConfig, outDir);
  const server = await preview({
    ...sharedConfig,
    plugins: [
      ...(sharedConfig.plugins ?? []),
      controlUiE2eGatewayAssetPathPlugin(),
      controlUiE2ePreviewConfigPlugin(bootstrapConfig),
    ],
    preview: {
      host: "127.0.0.1",
      port,
      strictPort: true,
    },
  });
  try {
    return {
      baseUrl: resolveServerBaseUrl(server),
      close: () => server.close(),
    };
  } catch (error) {
    await server.close().catch(() => {});
    throw error;
  }
}

export async function startBundledControlUiE2eServer(outDir: string): Promise<ControlUiE2eServer> {
  const [{ build }, { default: controlUiViteConfig }] = await Promise.all([
    import("vite"),
    import("../../vite.config.ts"),
  ]);
  await build(createBundledControlUiE2eConfig(controlUiViteConfig, outDir));
  return startBuiltControlUiE2eServer(outDir);
}

export async function startProductionControlUiE2eServer(
  outDir: string,
  buildId: string,
  bootstrapConfig?: Record<string, unknown>,
): Promise<ControlUiE2eServer> {
  await buildProductionControlUiE2e(outDir, buildId);
  return startBuiltControlUiE2eServer(outDir, bootstrapConfig);
}

async function resolveAvailableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("Could not reserve a loopback port")));
        return;
      }
      probe.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function resolveServerBaseUrl(server: ViteDevServer | PreviewServer): string {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Control UI E2E server did not expose a TCP port");
  }
  return `http://127.0.0.1:${address.port}/`;
}

function normalizeScenario(
  scenario: ControlUiMockGatewayScenario,
): NormalizedControlUiMockGatewayScenario {
  const defaultAgentId = scenario.defaultAgentId?.trim() || "main";
  const sessionKey = scenario.sessionKey?.trim() || "main";
  const basePathValue = scenario.basePath?.trim() ?? "";
  const basePathWithSlash = basePathValue
    ? basePathValue.startsWith("/")
      ? basePathValue
      : `/${basePathValue}`
    : "";
  const basePath =
    basePathWithSlash.length > 1 && basePathWithSlash.endsWith("/")
      ? basePathWithSlash.slice(0, -1)
      : basePathWithSlash;
  return {
    attachmentMaxBytes: scenario.attachmentMaxBytes ?? DEFAULT_MOCK_ATTACHMENT_MAX_BYTES,
    agentModel:
      scenario.agentModel === undefined ? "openai/gpt-5.5" : scenario.agentModel?.trim() || null,
    assistantAgentId: scenario.assistantAgentId?.trim() || defaultAgentId,
    assistantName: scenario.assistantName?.trim() || "OpenClaw",
    basePath,
    controlUiTabs: scenario.controlUiTabs ?? [],
    controlUiWidgetKinds: scenario.controlUiWidgetKinds ?? [],
    allowedSessionVisibilities: scenario.allowedSessionVisibilities ?? [
      "shared",
      "read-only",
      "suggest",
      "draft",
    ],
    hasMultipleSessionSharingIdentities: scenario.hasMultipleSessionSharingIdentities ?? false,
    featureCapabilities: scenario.featureCapabilities ?? [],
    defaultAgentId,
    deferredMethods: scenario.deferredMethods ?? [],
    devGitBranch: scenario.devGitBranch?.trim() || "",
    serverBuildId: scenario.serverBuildId?.trim() || "e2e",
    controlUiBuildSource: scenario.controlUiBuildSource ?? "bundled",
    serverVersion: scenario.serverVersion?.trim() || "e2e",
    deviceToken: scenario.deviceToken?.trim() || "e2e-device-token",
    // Baseline scenarios represent a current Gateway. Tests for unsupported or
    // mixed-version methods provide an explicit narrower catalog.
    featureMethods: scenario.featureMethods ?? [...defaultControlUiFeatureMethods],
    omitFeatureMethods: scenario.omitFeatureMethods ?? false,
    historyMessages: scenario.historyMessages ?? [],
    maxPayload: scenario.maxPayload ?? DEFAULT_MOCK_MAX_PAYLOAD_BYTES,
    methodResponses: scenario.methodResponses ?? {},
    webSocketPassthroughPrefixes: scenario.webSocketPassthroughPrefixes ?? [],
    inFlightRun: scenario.inFlightRun ?? null,
    presenceUsers: scenario.presenceUsers ?? [],
    models: scenario.models ?? [{ id: "gpt-5.5", name: "gpt-5.5", provider: "openai" }],
    operatorScopes: scenario.operatorScopes ?? [
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
    ],
    repeatingSessionEvents: scenario.repeatingSessionEvents ?? { events: [] },
    sessionInfo: scenario.sessionInfo ?? null,
    sessionArchiveFiltering: scenario.sessionArchiveFiltering ?? false,
    sessionKey,
    sessionGroups: scenario.sessionGroups ?? [],
    sessionGroupDefaults: scenario.sessionGroupDefaults ?? {},
    terminalEnabled: scenario.terminalEnabled ?? false,
    cliAgentsEnabled: scenario.cliAgentsEnabled ?? false,
    workspace: scenario.workspace ?? "",
    workspaceGit: scenario.workspaceGit ?? false,
    localMediaPreviewRoots: scenario.localMediaPreviewRoots ?? [],
  };
}

export function createControlUiMockBootstrapConfig(scenario: ControlUiMockGatewayScenario = {}) {
  const normalizedScenario = normalizeScenario(scenario);
  return {
    allowExternalEmbedUrls: false,
    assistantAgentId: normalizedScenario.assistantAgentId,
    assistantAvatar: "",
    assistantName: normalizedScenario.assistantName,
    basePath: normalizedScenario.basePath,
    devGitBranch: normalizedScenario.devGitBranch || undefined,
    embedSandbox: "scripts",
    localMediaPreviewRoots: normalizedScenario.localMediaPreviewRoots,
    serverVersion: normalizedScenario.serverVersion,
    serverBuildId: normalizedScenario.serverBuildId,
    terminalEnabled: normalizedScenario.terminalEnabled,
    cliAgentsEnabled: normalizedScenario.cliAgentsEnabled,
  };
}

export function createControlUiMockGatewayInitScript(
  scenario: ControlUiMockGatewayScenario = {},
): string {
  const input = {
    protocolVersion: PROTOCOL_VERSION,
    scenario: normalizeScenario(scenario),
  };
  return `${json5BrowserSource}\n;(() => { const __name = (target) => target; (${installControlUiMockGateway.toString()})(${JSON.stringify(input)}, globalThis.JSON5.parse); })();`;
}

function installControlUiMockGateway(
  input: {
    protocolVersion: number;
    scenario: NormalizedControlUiMockGatewayScenario;
  },
  parseJson5: (raw: string) => unknown,
) {
  const NativeWebSocket = window.WebSocket;
  type BrowserRequest = { id: string; method: string; params?: unknown };
  type BrowserFrame = {
    id?: unknown;
    method?: unknown;
    params?: unknown;
    type?: unknown;
  };
  type BrowserScenario = NormalizedControlUiMockGatewayScenario;
  type BrowserMethodResponseCase = {
    match?: Record<string, unknown>;
    response?: unknown;
  };
  type BrowserMethodResponseCases = {
    cases?: BrowserMethodResponseCase[];
  };
  type BrowserMethodResponseSequence = {
    sequence?: unknown[];
  };
  type DeferredResponse = {
    id: string;
    method: string;
    params?: unknown;
    socket: { deliver: (frame: unknown) => void };
  };
  type DeferredMethod = {
    method: string;
    match?: Record<string, unknown>;
  };
  type MockTerminalSession = {
    sessionId: string;
    agentId: string;
    shell: string;
    cwd: string;
    confined: boolean;
    attached: boolean;
    owner: "conn";
    createdAtMs: number;
    buffer: string;
    seq: number;
  };
  type ExposedGateway = {
    closeLatest: (code?: number, reason?: string) => void;
    deliverLatest: (frame: unknown) => void;
    deferNext: (method: string, match?: Record<string, unknown>) => void;
    emit: (event: string, payload?: unknown) => void;
    findRequests: (method?: string) => BrowserRequest[];
    rejectDeferred: (
      method: string,
      error?: { code?: string; message?: string; details?: unknown; retryable?: boolean },
    ) => void;
    requests: BrowserRequest[];
    resolveDeferred: (method: string, payload?: unknown) => void;
    setOnline: (online: boolean) => void;
    setServerBuildId: (buildId: string) => void;
    setOperatorScopes: (scopes: string[]) => void;
    setHistoryMessages: (messages: unknown[]) => void;
    setMethodResponse: (method: string, payload: unknown) => void;
    setSessionSharingPolicy: (policy: {
      allowedSessionVisibilities: Array<"shared" | "read-only" | "suggest" | "draft">;
      hasMultipleSessionSharingIdentities: boolean;
    }) => void;
    socketCount: () => number;
    socketStates: () => Array<{ readyState: number; state: string; url: string }>;
    socketUrls: () => string[];
  };
  type WindowWithGateway = Window & {
    __OPENCLAW_CONTROL_UI_BASE_PATH__?: string;
    openclawControlUiE2eGateway?: ExposedGateway;
  };

  const scenario: BrowserScenario = input.scenario;
  const serverBuildIdStateKey = "openclaw.control-ui-e2e.serverBuildId";
  let serverBuildId = scenario.serverBuildId;
  try {
    serverBuildId = window.sessionStorage.getItem(serverBuildIdStateKey)?.trim() || serverBuildId;
  } catch {
    // The scenario value remains authoritative when browser storage is unavailable.
  }
  (window as unknown as WindowWithGateway)["__OPENCLAW_CONTROL_UI_BASE_PATH__"] = scenario.basePath;
  const protocolVersion = input.protocolVersion;
  const methodResponseOverridesStorageKey = "openclaw.control-ui-e2e.method-responses.v1";
  const methodResponseOverrides: Record<string, unknown> = {};
  try {
    const storedOverrides = window.sessionStorage.getItem(methodResponseOverridesStorageKey);
    const parsedOverrides = storedOverrides ? (JSON.parse(storedOverrides) as unknown) : null;
    if (isRecord(parsedOverrides)) {
      Object.assign(methodResponseOverrides, parsedOverrides);
      Object.assign(scenario.methodResponses, parsedOverrides);
    }
  } catch {
    // Opaque initial documents may not expose storage; the target page will.
  }
  const deferredMethods: DeferredMethod[] = scenario.deferredMethods.map((method) => ({ method }));
  const deferredResponses: DeferredResponse[] = [];
  const requests: BrowserRequest[] = [];
  const methodResponseSequenceIndexes = new Map<string, number>();
  const sessionPatches = new Map<string, Record<string, unknown>>();
  const createdSessions = new Map<string, Record<string, unknown>>();
  const terminalSessions = new Map<string, MockTerminalSession>();
  let terminalSessionSequence = 0;
  const sessionMessageSubscriptions = new Set<string>();
  const sockets: Array<{
    readonly readyState: number;
    readonly url: string;
    close: (code?: number, reason?: string) => void;
    openConnection: () => void;
  }> = [];
  let sessionMessageEventIndex = 0;
  let sessionMessageEventTimer: number | null = null;
  const offlineStateKey = "openclaw.control-ui-e2e.gatewayOffline";
  // Gateway-owned custom group catalog (sessions.groups.*). Persisted in
  // sessionStorage so a page reload keeps the catalog the way the real
  // gateway's SQLite store does; renames replay onto static sessions.list
  // fixtures because the real gateway rewrites member categories server-side.
  const groupsStateKey = "openclaw.control-ui-e2e.sessionGroups";
  let groupsState: {
    names: string[];
    defaults: Record<string, { cwd?: string; worktree?: boolean }>;
    sectionOrder: string[];
    renames: Array<{ from: string; to: string | null }>;
  } = {
    names: [...input.scenario.sessionGroups],
    defaults: { ...input.scenario.sessionGroupDefaults },
    sectionOrder: [],
    renames: [],
  };
  let online = true;
  try {
    online = window.sessionStorage.getItem(offlineStateKey) !== "1";
  } catch {
    // Storage-disabled browser contexts still get the in-memory mock default.
  }
  try {
    const rawGroups = window.sessionStorage.getItem(groupsStateKey);
    if (rawGroups) {
      groupsState = JSON.parse(rawGroups) as typeof groupsState;
      groupsState.sectionOrder ??= [];
      groupsState.defaults ??= {};
    }
  } catch {
    // Storage-disabled browser contexts still get the scenario catalog.
  }
  let seq = 0;
  // Stateful config store: config.set/config.apply persist the submitted raw
  // and advance the hash so autosave -> reload flows round-trip edits the way
  // the real gateway does. Active only when the scenario ships a config.get
  // fixture with a raw string; persisted in sessionStorage like groupsState.
  const configStateKey = "openclaw.control-ui-e2e.configState";
  const baseConfigResponse: Record<string, unknown> | null = (() => {
    const configured = scenario.methodResponses["config.get"];
    return isRecord(configured) && typeof configured.raw === "string" ? configured : null;
  })();
  const initialConfigHash =
    typeof baseConfigResponse?.hash === "string" ? baseConfigResponse.hash : "mock-config-hash-0";
  const initialAppliedConfigHash =
    typeof baseConfigResponse?.appliedConfigHash === "string"
      ? baseConfigResponse.appliedConfigHash
      : initialConfigHash;
  let lastConfiguredConfigHash = initialConfigHash;
  let configState: {
    raw: string;
    revision: number;
    hash: string;
    appliedHash: string;
  } | null = baseConfigResponse
    ? {
        raw: baseConfigResponse.raw as string,
        revision: 0,
        hash: initialConfigHash,
        appliedHash: initialAppliedConfigHash,
      }
    : null;
  try {
    const rawConfigState = configState ? window.sessionStorage.getItem(configStateKey) : null;
    if (rawConfigState) {
      const stored = JSON.parse(rawConfigState) as unknown;
      if (
        isRecord(stored) &&
        typeof stored.raw === "string" &&
        typeof stored.revision === "number"
      ) {
        configState = {
          raw: stored.raw,
          revision: stored.revision,
          hash: typeof stored.hash === "string" ? stored.hash : initialConfigHash,
          appliedHash:
            typeof stored.appliedHash === "string" ? stored.appliedHash : initialAppliedConfigHash,
        };
      }
    }
  } catch {
    // Storage-disabled browser contexts still get the scenario fixture.
  }

  function persistConfigState(): void {
    try {
      window.sessionStorage.setItem(configStateKey, JSON.stringify(configState));
    } catch {
      // In-memory config still serves the current page.
    }
  }

  function mockConfigHash(): string {
    return configState?.hash ?? initialConfigHash;
  }

  function mockAppliedConfigHash(): string {
    return configState?.appliedHash ?? initialAppliedConfigHash;
  }

  function persistGroupsState(): void {
    try {
      window.sessionStorage.setItem(groupsStateKey, JSON.stringify(groupsState));
    } catch {
      // In-memory catalog still serves the current page.
    }
  }

  function groupsPayload(): {
    groups: Array<{ name: string; position: number }>;
    sectionOrder: string[];
  } {
    return {
      groups: groupsState.names.map((name, position) => ({ name, position })),
      sectionOrder: [...groupsState.sectionOrder],
    };
  }

  function groupDefaultsPayload() {
    return {
      defaults: groupsState.names.map((name) => ({ name, ...groupsState.defaults[name] })),
    };
  }

  function normalizedGroupNames(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const seen = new Set<string>();
    const names: string[] = [];
    for (const raw of value) {
      const name = typeof raw === "string" ? raw.trim() : "";
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    return names;
  }

  // This function is serialized with installControlUiMockGateway.toString().
  // Keep the guard local so the generated script captures no module imports.
  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function hasOwn(record: Record<string, unknown>, key: string): boolean {
    return Object.hasOwn(record, key);
  }

  function valuesEqual(actual: unknown, expected: unknown): boolean {
    if (Object.is(actual, expected)) {
      return true;
    }
    if ((actual && typeof actual === "object") || (expected && typeof expected === "object")) {
      try {
        return JSON.stringify(actual) === JSON.stringify(expected);
      } catch {
        return false;
      }
    }
    return false;
  }

  function paramsMatch(params: unknown, match: Record<string, unknown> | undefined): boolean {
    if (!match) {
      return true;
    }
    const entries = Object.entries(match);
    if (entries.length === 0) {
      return true;
    }
    if (!isRecord(params)) {
      return false;
    }
    return entries.every(
      ([key, expected]) => hasOwn(params, key) && valuesEqual(params[key], expected),
    );
  }

  function responseCases(value: unknown): BrowserMethodResponseCase[] | null {
    if (!isRecord(value)) {
      return null;
    }
    const maybeCases = (value as BrowserMethodResponseCases).cases;
    return Array.isArray(maybeCases) ? maybeCases : null;
  }

  function responseSequence(value: unknown): unknown[] | null {
    if (!isRecord(value)) {
      return null;
    }
    const maybeSequence = (value as BrowserMethodResponseSequence).sequence;
    return Array.isArray(maybeSequence) ? maybeSequence : null;
  }

  function configuredResponse(
    method: string,
    params: unknown,
  ): { found: boolean; value?: unknown } {
    if (!hasOwn(scenario.methodResponses, method)) {
      return { found: false };
    }
    const configured = scenario.methodResponses[method];
    const sequence = responseSequence(configured);
    if (sequence) {
      if (sequence.length === 0) {
        return { found: false };
      }
      const index = methodResponseSequenceIndexes.get(method) ?? 0;
      methodResponseSequenceIndexes.set(method, index + 1);
      // Keep the final response stable so harmless UI retries remain deterministic.
      return { found: true, value: sequence[Math.min(index, sequence.length - 1)] };
    }
    const cases = responseCases(configured);
    if (!cases) {
      return { found: true, value: configured };
    }
    const matchingCase = cases.find((candidate) => paramsMatch(params, candidate.match));
    if (!matchingCase) {
      return { found: false };
    }
    return { found: true, value: matchingCase.response };
  }

  function applyScenarioAgentModel(method: string, value: unknown): unknown {
    if (!scenario.agentModel || !isRecord(value)) {
      return value;
    }
    const applyAgentsList = (agentsList: unknown): unknown => {
      if (!isRecord(agentsList) || !Array.isArray(agentsList.agents)) {
        return agentsList;
      }
      return {
        ...agentsList,
        agents: agentsList.agents.map((agent) =>
          isRecord(agent) && !hasOwn(agent, "model")
            ? { ...agent, model: { primary: scenario.agentModel } }
            : agent,
        ),
      };
    };
    if (method === "agents.list") {
      return applyAgentsList(value);
    }
    if (method === "chat.startup" && hasOwn(value, "agentsList")) {
      return {
        ...value,
        agentsList: applyAgentsList(value.agentsList),
      };
    }
    return value;
  }

  /** Transcript fields a scenario configured on chat.history, replayed onto the
   * chat.startup payload so both bootstrap paths serve the same conversation. */
  function configuredHistoryTranscript(): Record<string, unknown> {
    const configured = scenario.methodResponses["chat.history"];
    if (!isRecord(configured) || responseCases(configured) || responseSequence(configured)) {
      return {};
    }
    const transcript: Record<string, unknown> = {};
    for (const field of ["messages", "sessionId", "sessionInfo", "inFlightRun", "thinkingLevel"]) {
      if (hasOwn(configured, field)) {
        transcript[field] = configured[field];
      }
    }
    return transcript;
  }

  /** Presence slice of the connect snapshot. The self-flagged entry adopts the
   * connecting client's instanceId so presence surfaces resolve "you". */
  function presenceSnapshot(connectParams: unknown): { presence?: unknown[] } {
    if (scenario.presenceUsers.length === 0) {
      return {};
    }
    const client = isRecord(connectParams) ? connectParams.client : undefined;
    const selfInstanceId =
      isRecord(client) && typeof client.instanceId === "string"
        ? client.instanceId
        : "e2e-self-instance";
    return {
      presence: scenario.presenceUsers.map((user, index) => ({
        instanceId: user.self ? selfInstanceId : `e2e-presence-${index}`,
        mode: "webchat",
        reason: "connect",
        user: {
          id: user.id,
          name: user.name ?? null,
          email: user.email ?? null,
          avatarUrl: user.avatarUrl ?? null,
        },
        watchedSessions: user.watchedSessions ?? [],
      })),
    };
  }

  function recordSessionPatch(params: unknown): void {
    if (!isRecord(params) || typeof params.key !== "string") {
      return;
    }
    const patch = { ...sessionPatches.get(params.key) };
    for (const key of [
      "model",
      "thinkingLevel",
      "fastMode",
      "label",
      "category",
      "icon",
      "boardFace",
      "pinned",
      "unread",
      "toolOverrides",
    ] as const) {
      if (hasOwn(params, key)) {
        patch[key] = params[key];
      }
    }
    if (scenario.sessionArchiveFiltering && hasOwn(params, "archived")) {
      patch.archived = params.archived;
    }
    sessionPatches.set(params.key, patch);
  }

  function recordSessionsPatchMany(params: unknown, response: unknown): void {
    if (!isRecord(params) || !Array.isArray(params.targets) || !isRecord(params.patch)) {
      return;
    }
    const outcomes =
      isRecord(response) && Array.isArray(response.outcomes) ? response.outcomes : [];
    for (const [index, target] of params.targets.entries()) {
      const outcome = outcomes[index];
      if (!isRecord(target) || !isRecord(outcome) || outcome.ok !== true) {
        continue;
      }
      recordSessionPatch({ ...target, ...params.patch });
    }
  }

  function recordMaterializedSession(params: unknown, response: unknown): void {
    if (!isRecord(response)) {
      return;
    }
    const key =
      typeof response.key === "string"
        ? response.key
        : typeof response.sessionKey === "string"
          ? response.sessionKey
          : "";
    if (!key.trim()) {
      return;
    }
    const label = isRecord(params) && typeof params.label === "string" ? params.label.trim() : "";
    const {
      displayName: _defaultDisplayName,
      label: _defaultLabel,
      ...defaultSession
    } = sessionRow();
    createdSessions.set(key, {
      ...defaultSession,
      key,
      ...(label ? { displayName: label, label } : {}),
      hasActiveRun: response.runStarted === true,
      status: response.runStarted === true ? "running" : "done",
    });
  }

  function applySessionPatches(response: unknown, params: unknown): unknown {
    if (!isRecord(response) || !Array.isArray(response.sessions)) {
      return response;
    }
    const archivedFilter =
      isRecord(params) && params.archived === "all"
        ? "all"
        : isRecord(params) && params.archived === true
          ? "archived"
          : "active";
    const knownSessionKeys = new Set(
      response.sessions.flatMap((row) =>
        isRecord(row) && typeof row.key === "string" ? [row.key] : [],
      ),
    );
    // Successful session creation and catalog adoption commit before their
    // responses. Route resolution must see either session in the next list.
    const sourceSessions = [
      ...response.sessions,
      ...[...createdSessions].flatMap(([key, row]) => (knownSessionKeys.has(key) ? [] : [row])),
    ];
    const sessions = sourceSessions.map((row) => {
      if (!isRecord(row) || typeof row.key !== "string") {
        return row;
      }
      const patch = sessionPatches.get(row.key);
      const next = Object.assign({}, row, patch);
      // Replay group renames/deletes over static fixtures: the real gateway
      // rewrites member categories server-side before the next sessions.list.
      let category = typeof next.category === "string" ? next.category : undefined;
      for (const rename of groupsState.renames) {
        if (category === rename.from) {
          category = rename.to ?? undefined;
        }
      }
      if (category === undefined) {
        delete next.category;
      } else {
        next.category = category;
      }
      return next;
    });
    if (!scenario.sessionArchiveFiltering) {
      return {
        ...response,
        ...(createdSessions.size > 0 ? { count: sessions.length } : {}),
        sessions,
      };
    }
    const filteredSessions = sessions.filter(
      (row) =>
        isRecord(row) &&
        (archivedFilter === "all" || (row.archived === true) === (archivedFilter === "archived")),
    );
    return {
      ...response,
      count: filteredSessions.length,
      sessions: filteredSessions,
    };
  }

  function stopRepeatingSessionEvents(): void {
    if (sessionMessageEventTimer !== null) {
      window.clearInterval(sessionMessageEventTimer);
      sessionMessageEventTimer = null;
    }
  }

  function emitRepeatingSessionEvent(): void {
    const events = scenario.repeatingSessionEvents.events;
    if (events.length === 0) {
      return;
    }
    const event = events[sessionMessageEventIndex % events.length];
    sessionMessageEventIndex += 1;
    if (!event || !isRecord(event.payload) || typeof event.payload.sessionKey !== "string") {
      return;
    }
    if (!sessionMessageSubscriptions.has(event.payload.sessionKey)) {
      return;
    }
    MockWebSocket.latest?.deliver({
      event: event.event,
      payload: event.payload,
      seq: ++seq,
      type: "event",
    });
  }

  function startRepeatingSessionEvents(): void {
    if (sessionMessageEventTimer !== null || scenario.repeatingSessionEvents.events.length === 0) {
      return;
    }
    emitRepeatingSessionEvent();
    const intervalMs = Math.max(250, scenario.repeatingSessionEvents.intervalMs ?? 3_000);
    sessionMessageEventTimer = window.setInterval(emitRepeatingSessionEvent, intervalMs);
  }

  function updateSessionMessageSubscription(method: string, params: unknown): void {
    const sessionKey = isRecord(params) && typeof params.key === "string" ? params.key : "";
    if (!sessionKey) {
      return;
    }
    if (method === "sessions.messages.subscribe") {
      sessionMessageSubscriptions.add(sessionKey);
      startRepeatingSessionEvents();
      return;
    }
    if (method === "sessions.messages.unsubscribe") {
      sessionMessageSubscriptions.delete(sessionKey);
      if (sessionMessageSubscriptions.size === 0) {
        stopRepeatingSessionEvents();
      }
    }
  }

  function sessionRow() {
    return {
      contextTokens: null,
      displayName: "Main",
      hasActiveRun: false,
      key: scenario.sessionKey,
      kind: "direct",
      label: "Main",
      model: "gpt-5.5",
      modelProvider: "openai",
      status: "done",
      totalTokens: 0,
      updatedAt: Date.now(),
    };
  }

  function buildResponse(method: string, params: unknown): unknown {
    if (method === "sessions.patch") {
      recordSessionPatch(params);
    }
    if (configState && baseConfigResponse) {
      if (method === "config.get") {
        const configured = configuredResponse(method, params);
        const configuredConfig = isRecord(configured.value) ? configured.value : baseConfigResponse;
        if (
          typeof configuredConfig.raw === "string" &&
          typeof configuredConfig.hash === "string" &&
          configuredConfig.hash !== lastConfiguredConfigHash
        ) {
          lastConfiguredConfigHash = configuredConfig.hash;
          configState = {
            raw: configuredConfig.raw,
            revision: configState.revision,
            hash: configuredConfig.hash,
            appliedHash:
              typeof configuredConfig.appliedConfigHash === "string"
                ? configuredConfig.appliedConfigHash
                : configuredConfig.hash,
          };
          persistConfigState();
        }
        let parsedConfig: unknown = configuredConfig.config;
        try {
          parsedConfig = parseJson5(configState.raw);
        } catch {
          // Invalid raw keeps the last valid fixture object for generic mock scenarios.
        }
        return {
          ...configuredConfig,
          config: parsedConfig,
          hash: mockConfigHash(),
          configRevisionHash: mockConfigHash(),
          appliedConfigHash: mockAppliedConfigHash(),
          raw: configState.raw,
        };
      }
      if (method === "config.set" || method === "config.apply") {
        // Enforce the production CAS contract: stale base hashes are rejected
        // (same code/message as the gateway) so conflict recovery is testable.
        const baseHash = isRecord(params) ? params.baseHash : undefined;
        if (baseHash !== mockConfigHash()) {
          return {
            __mockError: {
              code: "INVALID_REQUEST",
              message: "config changed since last load; re-run config.get and retry",
            },
          };
        }
        const raw = isRecord(params) && typeof params.raw === "string" ? params.raw : null;
        if (raw !== null) {
          const revision = configState.revision + 1;
          const hash = `mock-config-hash-${revision}`;
          configState = {
            raw,
            revision,
            hash,
            appliedHash:
              method === "config.apply"
                ? hash
                : (configState.appliedHash ?? initialAppliedConfigHash),
          };
          persistConfigState();
        }
        let parsedConfig: unknown = baseConfigResponse.config;
        try {
          parsedConfig = parseJson5(configState.raw);
        } catch {
          // Invalid raw keeps the last valid fixture object for generic mock scenarios.
        }
        const configured = configuredResponse(method, params);
        const configuredAck = isRecord(configured.value) ? configured.value : {};
        // Like the real gateway, return the persisted config and its new hash.
        return {
          ...configuredAck,
          ok: true,
          path: baseConfigResponse.path,
          hash: mockConfigHash(),
          config: parsedConfig,
        };
      }
    }
    const configured = configuredResponse(method, params);
    if (configured.found) {
      const configuredValue = applyScenarioAgentModel(method, configured.value);
      if (method === "sessions.create" || method === "sessions.catalog.continue") {
        recordMaterializedSession(params, configuredValue);
      }
      if (method === "sessions.patchMany") {
        recordSessionsPatchMany(params, configuredValue);
      }
      return method === "sessions.list"
        ? applySessionPatches(configuredValue, params)
        : configuredValue;
    }
    switch (method) {
      case "connect": {
        const auth = isRecord(params) && isRecord(params.auth) ? params.auth : null;
        const connectedDeviceToken =
          auth && typeof auth.deviceToken === "string" ? auth.deviceToken : scenario.deviceToken;
        return {
          auth: {
            deviceToken: connectedDeviceToken,
            recoveryMigrationAllowed: true as const,
            recoveryScope: "e2e-recovery-scope",
            role: "operator",
            scopes: scenario.operatorScopes,
          },
          features: {
            capabilities: scenario.featureCapabilities,
            events: [],
            ...(scenario.omitFeatureMethods ? {} : { methods: scenario.featureMethods }),
          },
          controlUiTabs: scenario.controlUiTabs,
          controlUiWidgetKinds: scenario.controlUiWidgetKinds,
          protocol: protocolVersion,
          server: {
            buildId: serverBuildId,
            controlUiBuildSource: scenario.controlUiBuildSource,
            connId: "control-ui-e2e",
            version: scenario.serverVersion,
          },
          policy: {
            maxPayload: scenario.maxPayload,
            maxBufferedBytes: 1_048_576,
            tickIntervalMs: 30_000,
            attachments: {
              maxBytes: scenario.attachmentMaxBytes,
              maxImageBytes: Math.min(scenario.attachmentMaxBytes, 5 * 1024 * 1024),
            },
            allowedSessionVisibilities: scenario.allowedSessionVisibilities,
            hasMultipleSessionSharingIdentities: scenario.hasMultipleSessionSharingIdentities,
          },
          snapshot: {
            ...presenceSnapshot(params),
            sessionDefaults: {
              defaultAgentId: scenario.defaultAgentId,
              mainKey: "main",
              mainSessionKey: scenario.sessionKey,
              scope: "agent",
            },
          },
          type: "hello-ok",
        };
      }
      case "agent.identity.get":
        return {
          agentId: scenario.assistantAgentId,
          avatar: "",
          avatarStatus: "none",
          name: scenario.assistantName,
        };
      case "agents.list":
        return {
          agents: [
            {
              id: scenario.defaultAgentId,
              identity: { name: scenario.assistantName },
              ...(scenario.agentModel ? { model: { primary: scenario.agentModel } } : {}),
              name: scenario.assistantName,
              ...(scenario.workspace ? { workspace: scenario.workspace } : {}),
              workspaceGit: scenario.workspaceGit,
            },
          ],
          defaultId: scenario.defaultAgentId,
          mainKey: "main",
          scope: "agent",
        };
      case "agents.files.list":
        return {
          agentId:
            isRecord(params) && typeof params.agentId === "string"
              ? params.agentId
              : scenario.defaultAgentId,
          files: [],
          workspace: "",
        };
      case "agents.files.get":
        return null;
      case "sessions.files.list":
        return {
          browser: {
            entries: [],
            path: "",
          },
          files: [],
          root: "",
          sessionKey:
            isRecord(params) && typeof params.sessionKey === "string" ? params.sessionKey : "main",
        };
      case "sessions.files.get":
        return null;
      case "artifacts.list":
        return { artifacts: [] };
      case "artifacts.download":
        return null;
      case "chat.history":
        return {
          messages: scenario.historyMessages,
          sessionId: "control-ui-e2e-session",
          thinkingLevel: null,
          ...(scenario.inFlightRun ? { inFlightRun: scenario.inFlightRun } : {}),
          ...(scenario.sessionInfo ? { sessionInfo: scenario.sessionInfo } : {}),
        };
      case "chat.startup":
        return {
          agentsList: {
            agents: [
              {
                id: scenario.defaultAgentId,
                identity: { name: scenario.assistantName },
                ...(scenario.agentModel ? { model: { primary: scenario.agentModel } } : {}),
                name: scenario.assistantName,
                ...(scenario.workspace ? { workspace: scenario.workspace } : {}),
                workspaceGit: scenario.workspaceGit,
              },
            ],
            defaultId: scenario.defaultAgentId,
            mainKey: "main",
            scope: "agent",
          },
          messages: scenario.historyMessages,
          metadata: {
            models: scenario.models,
          },
          sessionId: "control-ui-e2e-session",
          thinkingLevel: null,
          ...(scenario.inFlightRun ? { inFlightRun: scenario.inFlightRun } : {}),
          ...(scenario.sessionInfo ? { sessionInfo: scenario.sessionInfo } : {}),
          // The transcript bootstrap picks chat.startup whenever the Gateway
          // advertises it, so a scenario that configures only chat.history would
          // otherwise have its transcript silently dropped on the startup path.
          ...configuredHistoryTranscript(),
        };
      case "chat.metadata":
        return {
          commands: [],
          models: scenario.models,
        };
      case "chat.send":
        return {
          runId:
            isRecord(params) && typeof params.idempotencyKey === "string"
              ? params.idempotencyKey
              : "control-ui-e2e-run",
          status: "started",
        };
      case "chat.abort":
        return { aborted: true };
      case "commands.list":
        return { commands: [] };
      case "health":
        return {
          agents: [],
          defaultAgentId: scenario.defaultAgentId,
          durationMs: 0,
          heartbeatSeconds: 0,
          ok: true,
          sessions: { count: 1, path: "", recent: [] },
          ts: Date.now(),
        };
      case "models.list":
        return { models: scenario.models };
      case "sessions.create": {
        const agentId =
          isRecord(params) && typeof params.agentId === "string"
            ? params.agentId
            : scenario.defaultAgentId;
        const requestedKey =
          isRecord(params) && typeof params.key === "string" ? params.key.trim() : "";
        const response = {
          key: requestedKey || `agent:${agentId}:mock-created-${createdSessions.size + 1}`,
        };
        recordMaterializedSession(params, response);
        return response;
      }
      case "sessions.list":
        return applySessionPatches(
          {
            count: 1,
            defaults: {
              contextTokens: null,
              model: "gpt-5.5",
              modelProvider: "openai",
            },
            path: "",
            sessions: [sessionRow()],
            ts: Date.now(),
          },
          params,
        );
      case "sessions.patchMany": {
        const targets = isRecord(params) && Array.isArray(params.targets) ? params.targets : [];
        const result = {
          outcomes: targets.map((target) => {
            const key = isRecord(target) && typeof target.key === "string" ? target.key : "unknown";
            if (isRecord(target) && typeof target.agentId === "string") {
              return { ok: true, key, agentId: target.agentId };
            }
            return { ok: true, key };
          }),
        };
        recordSessionsPatchMany(params, result);
        return result;
      }
      case "sessions.groups.list":
        return groupsPayload();
      case "sessions.groups.defaults":
        return groupDefaultsPayload();
      case "sessions.groups.put": {
        groupsState.names = normalizedGroupNames(isRecord(params) ? params.names : undefined);
        if (isRecord(params) && Array.isArray(params.sectionOrder)) {
          groupsState.sectionOrder = normalizedGroupNames(params.sectionOrder);
        }
        persistGroupsState();
        return { ok: true, ...groupsPayload() };
      }
      case "sessions.groups.rename": {
        const from = isRecord(params) && typeof params.name === "string" ? params.name.trim() : "";
        const to = isRecord(params) && typeof params.to === "string" ? params.to.trim() : "";
        if (from && to && from !== to) {
          const sourceIndex = groupsState.names.indexOf(from);
          const names = groupsState.names.filter((name) => name !== from);
          if (!names.includes(to)) {
            // Renames keep the source position, like the real catalog.
            names.splice(sourceIndex < 0 ? names.length : sourceIndex, 0, to);
          }
          groupsState.names = names;
          if (!groupsState.defaults[to] && groupsState.defaults[from]) {
            groupsState.defaults[to] = groupsState.defaults[from];
          }
          delete groupsState.defaults[from];
          const sourceSectionId = `category:${from}`;
          const targetSectionId = `category:${to}`;
          groupsState.sectionOrder = groupsState.sectionOrder.flatMap((sectionId) => {
            if (sectionId !== sourceSectionId) {
              return [sectionId];
            }
            return groupsState.sectionOrder.includes(targetSectionId) ? [] : [targetSectionId];
          });
          groupsState.renames.push({ from, to });
          persistGroupsState();
        }
        return { ok: true, updatedSessions: 0, ...groupsPayload() };
      }
      case "sessions.groups.update": {
        const name = isRecord(params) && typeof params.name === "string" ? params.name.trim() : "";
        if (name) {
          const cwd = isRecord(params) && typeof params.cwd === "string" ? params.cwd.trim() : "";
          groupsState.defaults[name] = {
            ...(cwd ? { cwd } : {}),
            worktree: isRecord(params) && params.worktree === true,
          };
          persistGroupsState();
        }
        return { ok: true, ...groupDefaultsPayload() };
      }
      case "sessions.groups.delete": {
        const name = isRecord(params) && typeof params.name === "string" ? params.name.trim() : "";
        if (name) {
          groupsState.names = groupsState.names.filter((existing) => existing !== name);
          delete groupsState.defaults[name];
          groupsState.sectionOrder = groupsState.sectionOrder.filter(
            (sectionId) => sectionId !== `category:${name}`,
          );
          groupsState.renames.push({ from: name, to: null });
          persistGroupsState();
        }
        return { ok: true, updatedSessions: 0, ...groupsPayload() };
      }
      case "sessions.subscribe":
        return { subscribed: true };
      case "sessions.messages.subscribe":
        return {
          key: isRecord(params) && typeof params.key === "string" ? params.key : "",
        };
      case "sessions.messages.unsubscribe":
        return { ok: true };
      case "terminal.open": {
        const sessionId = `control-ui-mock-terminal-${++terminalSessionSequence}`;
        const session: MockTerminalSession = {
          sessionId,
          agentId:
            isRecord(params) && typeof params.agentId === "string"
              ? params.agentId
              : scenario.defaultAgentId,
          shell: "/bin/zsh",
          cwd: scenario.workspace || "/workspace/openclaw",
          confined: false,
          attached: true,
          owner: "conn",
          createdAtMs: Date.now(),
          buffer: "",
          seq: 0,
        };
        terminalSessions.set(sessionId, session);
        return {
          sessionId: session.sessionId,
          agentId: session.agentId,
          shell: session.shell,
          cwd: session.cwd,
          confined: session.confined,
        };
      }
      case "terminal.attach": {
        const sessionId = isRecord(params) ? params.sessionId : undefined;
        const session = typeof sessionId === "string" ? terminalSessions.get(sessionId) : null;
        return session
          ? {
              sessionId: session.sessionId,
              agentId: session.agentId,
              shell: session.shell,
              cwd: session.cwd,
              confined: session.confined,
              buffer: session.buffer,
              seq: session.seq,
            }
          : {};
      }
      case "terminal.list":
        return {
          sessions: [...terminalSessions.values()].map(
            ({ buffer: _buffer, seq: _seq, ...session }) => session,
          ),
        };
      case "terminal.input":
      case "terminal.resize":
        return { ok: true };
      case "terminal.close": {
        const sessionId = isRecord(params) ? params.sessionId : undefined;
        if (typeof sessionId === "string") {
          terminalSessions.delete(sessionId);
        }
        return { ok: true };
      }
      default:
        return {};
    }
  }

  function emitTerminalOutput(
    socket: { deliver: (frame: unknown) => void },
    method: string,
    params: unknown,
    response: unknown,
  ): void {
    let data = "";
    let session: MockTerminalSession | undefined;
    if (
      method === "terminal.open" &&
      isRecord(response) &&
      typeof response.sessionId === "string"
    ) {
      session = terminalSessions.get(response.sessionId);
      data = "OpenClaw mock terminal\r\nType anything and the mock Gateway will echo it.\r\n$ ";
    } else if (method === "terminal.input" && isRecord(params)) {
      session =
        typeof params.sessionId === "string" ? terminalSessions.get(params.sessionId) : undefined;
      data = typeof params.data === "string" ? params.data : "";
    }
    if (!session || !data) {
      return;
    }
    session.buffer += data;
    session.seq += data.length;
    socket.deliver({
      event: "terminal.data",
      payload: { sessionId: session.sessionId, seq: session.seq, data },
      seq: ++seq,
      type: "event",
    });
  }

  function shouldDefer(method: string, params: unknown): boolean {
    const index = deferredMethods.findIndex(
      (candidate) => candidate.method === method && paramsMatch(params, candidate.match),
    );
    if (index < 0) {
      return false;
    }
    deferredMethods.splice(index, 1);
    return true;
  }

  function parseFrame(raw: string | ArrayBufferLike | Blob | ArrayBufferView): BrowserFrame | null {
    if (typeof raw !== "string") {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as BrowserFrame;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  class MockWebSocket extends EventTarget {
    static readonly CLOSED = 3;
    static readonly CLOSING = 2;
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static latest: MockWebSocket | null = null;

    binaryType: BinaryType = "blob";
    readonly bufferedAmount = 0;
    readonly extensions = "";
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onopen: ((event: Event) => void) | null = null;
    readonly protocol = "";
    readyState = MockWebSocket.CONNECTING;
    readonly url: string;
    private tickTimer: number | null = null;

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      MockWebSocket.latest = this;
      sockets.push(this);
      window.setTimeout(() => {
        this.openConnection();
      }, 0);
    }

    openConnection(): void {
      if (!online || this.readyState !== MockWebSocket.CONNECTING) {
        return;
      }
      this.readyState = MockWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
      this.deliver({
        event: "connect.challenge",
        payload: { nonce: "control-ui-e2e-nonce", ts: Date.now() },
        type: "event",
      });
    }

    override dispatchEvent(event: Event): boolean {
      const dispatched = super.dispatchEvent(event);
      if (event.type === "open") {
        this.onopen?.(event);
      } else if (event.type === "message") {
        this.onmessage?.(event as MessageEvent);
      } else if (event.type === "close") {
        this.onclose?.(event as CloseEvent);
      } else if (event.type === "error") {
        this.onerror?.(event);
      }
      return dispatched;
    }

    close(code = 1000, reason = ""): void {
      if (this.readyState === MockWebSocket.CLOSED) {
        return;
      }
      this.readyState = MockWebSocket.CLOSED;
      if (this.tickTimer !== null) {
        window.clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
      sessionMessageSubscriptions.clear();
      stopRepeatingSessionEvents();
      this.dispatchEvent(new CloseEvent("close", { code, reason }));
    }

    send(raw: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      const frame = parseFrame(raw);
      if (!frame || frame.type !== "req") {
        return;
      }
      const id = typeof frame.id === "string" ? frame.id : "";
      const method = typeof frame.method === "string" ? frame.method : "";
      if (!id || !method) {
        return;
      }
      requests.push({ id, method, params: frame.params });
      if (shouldDefer(method, frame.params)) {
        deferredResponses.push({ id, method, params: frame.params, socket: this });
        return;
      }
      window.setTimeout(() => {
        const payload = buildResponse(method, frame.params);
        const mockError =
          isRecord(payload) && isRecord(payload["__mockError"]) ? payload["__mockError"] : null;
        this.deliver(
          mockError
            ? { id, ok: false, error: mockError, type: "res" }
            : { id, ok: true, payload, type: "res" },
        );
        if (!mockError) {
          emitTerminalOutput(this, method, frame.params, payload);
        }
        if (!mockError && method === "connect" && this.readyState === MockWebSocket.OPEN) {
          this.tickTimer = window.setInterval(() => {
            this.deliver({ event: "tick", payload: {}, seq: ++seq, type: "event" });
          }, 30_000);
        }
        if (!mockError) {
          updateSessionMessageSubscription(method, frame.params);
        }
        if (
          method === "chat.abort" &&
          isRecord(frame.params) &&
          typeof frame.params.runId === "string" &&
          typeof frame.params.sessionKey === "string"
        ) {
          this.deliver({
            event: "chat",
            payload: {
              runId: frame.params.runId,
              sessionKey: frame.params.sessionKey,
              state: "aborted",
            },
            seq: ++seq,
            type: "event",
          });
        }
      }, 0);
    }

    deliver(frame: unknown): void {
      if (this.readyState !== MockWebSocket.OPEN) {
        return;
      }
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
    }
  }

  const exposed: ExposedGateway = {
    closeLatest(code, reason) {
      MockWebSocket.latest?.close(code ?? 1006, reason ?? "mock close");
    },
    deliverLatest(frame) {
      MockWebSocket.latest?.deliver(frame);
    },
    deferNext(method, match) {
      deferredMethods.push({ method, match });
    },
    emit(event, payload) {
      MockWebSocket.latest?.deliver({
        event,
        payload,
        seq: ++seq,
        type: "event",
      });
    },
    findRequests(method) {
      return method ? requests.filter((request) => request.method === method) : [...requests];
    },
    rejectDeferred(method, error) {
      const index = deferredResponses.findIndex((response) => response.method === method);
      if (index < 0) {
        throw new Error(`No deferred mock Gateway response for ${method}`);
      }
      const [response] = deferredResponses.splice(index, 1);
      if (!response) {
        throw new Error(`Deferred mock Gateway response disappeared for ${method}`);
      }
      response.socket.deliver({
        error: {
          code: error?.code ?? "INVALID_REQUEST",
          message: error?.message ?? "mock Gateway rejected request",
          ...(error?.details ? { details: error.details } : {}),
          ...(error?.retryable ? { retryable: true } : {}),
        },
        id: response.id,
        ok: false,
        type: "res",
      });
    },
    requests,
    resolveDeferred(method, payload) {
      const index = deferredResponses.findIndex((response) => response.method === method);
      if (index < 0) {
        throw new Error(`No deferred mock Gateway response for ${method}`);
      }
      const [response] = deferredResponses.splice(index, 1);
      if (!response) {
        throw new Error(`Deferred mock Gateway response disappeared for ${method}`);
      }
      const resolvedPayload = applyScenarioAgentModel(
        response.method,
        payload ?? buildResponse(response.method, response.params),
      );
      if (
        response.method === "sessions.create" ||
        response.method === "sessions.catalog.continue"
      ) {
        recordMaterializedSession(response.params, resolvedPayload);
      }
      response.socket.deliver({
        id: response.id,
        ok: true,
        payload: resolvedPayload,
        type: "res",
      });
    },
    setOnline(nextOnline) {
      online = nextOnline;
      try {
        if (online) {
          window.sessionStorage.removeItem(offlineStateKey);
        } else {
          window.sessionStorage.setItem(offlineStateKey, "1");
        }
      } catch {
        // The current document can still toggle the in-memory mock.
      }
      if (!online) {
        // Close handlers can synchronously construct replacements. Snapshot the
        // transition members so an offline replacement stays ready for recovery.
        const transitionSockets = sockets.slice();
        for (const socket of transitionSockets) {
          socket.close(1006, "mock offline");
        }
        return;
      }
      const transitionSockets = sockets.slice();
      for (const socket of transitionSockets) {
        socket.openConnection();
      }
    },
    setServerBuildId(nextBuildId) {
      serverBuildId = nextBuildId;
      try {
        window.sessionStorage.setItem(serverBuildIdStateKey, nextBuildId);
      } catch {
        // The current document still observes the new identity.
      }
    },
    setOperatorScopes(scopes) {
      scenario.operatorScopes = [...scopes];
    },
    setMethodResponse(method, payload) {
      scenario.methodResponses[method] = payload;
      methodResponseSequenceIndexes.delete(method);
      methodResponseOverrides[method] = payload;
      try {
        window.sessionStorage.setItem(
          methodResponseOverridesStorageKey,
          JSON.stringify(methodResponseOverrides),
        );
      } catch {
        // Current-document responses still work if browser storage is unavailable.
      }
    },
    setSessionSharingPolicy(policy) {
      scenario.allowedSessionVisibilities = policy.allowedSessionVisibilities;
      scenario.hasMultipleSessionSharingIdentities = policy.hasMultipleSessionSharingIdentities;
    },
    setHistoryMessages(messages) {
      scenario.historyMessages = Array.isArray(messages) ? messages : [];
      const configuredHistory = scenario.methodResponses["chat.history"];
      if (isRecord(configuredHistory) && !responseCases(configuredHistory)) {
        configuredHistory.messages = scenario.historyMessages;
      }
    },
    socketCount() {
      return sockets.length;
    },
    socketStates() {
      return sockets.map((socket) => ({
        readyState: socket.readyState,
        state:
          socket.readyState === MockWebSocket.CONNECTING
            ? "connecting"
            : socket.readyState === MockWebSocket.OPEN
              ? "open"
              : socket.readyState === MockWebSocket.CLOSING
                ? "closing"
                : "closed",
        url: socket.url,
      }));
    },
    socketUrls() {
      return sockets.map((socket) => socket.url);
    },
  };

  (window as unknown as WindowWithGateway).openclawControlUiE2eGateway = exposed;
  const RoutedWebSocket = function (url: string | URL, protocols?: string | string[]) {
    const resolvedUrl = String(url);
    if (scenario.webSocketPassthroughPrefixes.some((prefix) => resolvedUrl.startsWith(prefix))) {
      return protocols === undefined
        ? new NativeWebSocket(resolvedUrl)
        : new NativeWebSocket(resolvedUrl, protocols);
    }
    return new MockWebSocket(resolvedUrl);
  };
  RoutedWebSocket.prototype = MockWebSocket.prototype;
  Object.assign(RoutedWebSocket, {
    CLOSED: MockWebSocket.CLOSED,
    CLOSING: MockWebSocket.CLOSING,
    CONNECTING: MockWebSocket.CONNECTING,
    OPEN: MockWebSocket.OPEN,
  });
  window.WebSocket = RoutedWebSocket as unknown as typeof WebSocket;
  window.addEventListener("pagehide", () => {
    sessionMessageSubscriptions.clear();
    stopRepeatingSessionEvents();
  });
}

export async function installMockGateway(
  page: Page,
  scenario: ControlUiMockGatewayScenario = {},
): Promise<MockGatewayControls> {
  const normalizedScenario = normalizeScenario(scenario);
  const diagnosticEvents = installControlUiE2ePageDiagnosticRing(page);
  await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
    route.fulfill({
      body: JSON.stringify(createControlUiMockBootstrapConfig(normalizedScenario)),
      contentType: "application/json",
      status: 200,
    }),
  );
  await installControlUiE2eUnhandledRejectionRing(page);
  await page.addInitScript({ content: createControlUiMockGatewayInitScript(normalizedScenario) });
  return createMockGatewayControls(page, normalizedScenario.sessionKey, diagnosticEvents);
}

function createMockGatewayControls(
  page: Page,
  defaultSessionKey: string,
  diagnosticEvents: ControlUiE2eDiagnosticEvent[],
): MockGatewayControls {
  const emitGatewayEvent = async (event: string, payload?: unknown) => {
    await page.evaluate(
      ({ eventName, eventPayload }) => {
        const gateway = (
          window as Window & {
            openclawControlUiE2eGateway?: {
              emit: (event: string, payload?: unknown) => void;
            };
          }
        ).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.emit(eventName, eventPayload);
      },
      { eventName: event, eventPayload: payload },
    );
  };

  const deliverLatest = async (frame: unknown) => {
    await page.evaluate((payload) => {
      const gateway = (
        window as Window & {
          openclawControlUiE2eGateway?: {
            deliverLatest: (frame: unknown) => void;
          };
        }
      ).openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("Mock Gateway is not installed");
      }
      gateway.deliverLatest(payload);
    }, frame);
  };

  const getRequests = async (method?: string) =>
    page.evaluate((targetMethod) => {
      const gateway = (
        window as Window & {
          openclawControlUiE2eGateway?: {
            findRequests: (method?: string) => MockGatewayRequest[];
          };
        }
      ).openclawControlUiE2eGateway;
      return gateway?.findRequests(targetMethod) ?? [];
    }, method);

  return {
    async closeLatest(code, reason) {
      await page.evaluate(
        ({ closeCode, closeReason }) => {
          const gateway = (
            window as Window & {
              openclawControlUiE2eGateway?: {
                closeLatest: (code?: number, reason?: string) => void;
              };
            }
          ).openclawControlUiE2eGateway;
          if (!gateway) {
            throw new Error("Mock Gateway is not installed");
          }
          gateway.closeLatest(closeCode, closeReason);
        },
        { closeCode: code, closeReason: reason },
      );
    },
    deliverLatest,
    async deferNext(method, match) {
      await page.evaluate(
        ({ targetMethod, requestMatch }) => {
          const gateway = (
            window as Window & {
              openclawControlUiE2eGateway?: {
                deferNext: (method: string, match?: Record<string, unknown>) => void;
              };
            }
          ).openclawControlUiE2eGateway;
          if (!gateway) {
            throw new Error("Mock Gateway is not installed");
          }
          gateway.deferNext(targetMethod, requestMatch);
        },
        { targetMethod: method, requestMatch: match },
      );
    },
    async emitChatFinal(params) {
      await emitGatewayEvent("chat", {
        message: {
          content: [{ text: params.text, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId: params.runId,
        sessionKey: params.sessionKey ?? defaultSessionKey,
        state: "final",
      });
    },
    emitGatewayEvent,
    getRequests,
    async getSocketCount() {
      return await page.evaluate(() => {
        const gateway = (
          window as Window & {
            openclawControlUiE2eGateway?: {
              socketCount: () => number;
            };
          }
        ).openclawControlUiE2eGateway;
        return gateway?.socketCount() ?? 0;
      });
    },
    async getSocketUrls() {
      return await page.evaluate(() => {
        const gateway = (
          window as Window & {
            openclawControlUiE2eGateway?: {
              socketUrls: () => string[];
            };
          }
        ).openclawControlUiE2eGateway;
        return gateway?.socketUrls() ?? [];
      });
    },
    async rejectDeferred(method, error) {
      await page.evaluate(
        ({ targetMethod, responseError }) => {
          const gateway = (
            window as Window & {
              openclawControlUiE2eGateway?: {
                rejectDeferred: (
                  method: string,
                  error?: {
                    code?: string;
                    message?: string;
                    details?: unknown;
                    retryable?: boolean;
                  },
                ) => void;
              };
            }
          ).openclawControlUiE2eGateway;
          if (!gateway) {
            throw new Error("Mock Gateway is not installed");
          }
          gateway.rejectDeferred(targetMethod, responseError);
        },
        { targetMethod: method, responseError: error },
      );
    },
    async resolveDeferred(method, payload) {
      await page.evaluate(
        ({ targetMethod, responsePayload }) => {
          const gateway = (
            window as Window & {
              openclawControlUiE2eGateway?: {
                resolveDeferred: (method: string, payload?: unknown) => void;
              };
            }
          ).openclawControlUiE2eGateway;
          if (!gateway) {
            throw new Error("Mock Gateway is not installed");
          }
          gateway.resolveDeferred(targetMethod, responsePayload);
        },
        { targetMethod: method, responsePayload: payload },
      );
    },
    async setOnline(online) {
      await page.evaluate((nextOnline) => {
        const gateway = (
          window as Window & {
            openclawControlUiE2eGateway?: {
              setOnline: (online: boolean) => void;
            };
          }
        ).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setOnline(nextOnline);
      }, online);
    },
    async setServerBuildId(buildId) {
      await page.evaluate((nextBuildId) => {
        const gateway = (
          window as Window & {
            openclawControlUiE2eGateway?: {
              setServerBuildId: (buildId: string) => void;
            };
          }
        ).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setServerBuildId(nextBuildId);
      }, buildId);
    },
    async setOperatorScopes(scopes) {
      await page.evaluate((nextScopes) => {
        const gateway = (
          window as Window & {
            openclawControlUiE2eGateway?: {
              setOperatorScopes: (scopes: string[]) => void;
            };
          }
        ).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setOperatorScopes(nextScopes);
      }, scopes);
    },
    async setHistoryMessages(messages) {
      await page.evaluate((nextMessages) => {
        const gateway = (
          window as Window & {
            openclawControlUiE2eGateway?: {
              setHistoryMessages: (messages: unknown[]) => void;
            };
          }
        ).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setHistoryMessages(nextMessages);
      }, messages);
    },
    async setMethodResponse(method, payload) {
      await page.evaluate(
        ({ targetMethod, responsePayload }) => {
          const gateway = (
            window as Window & {
              openclawControlUiE2eGateway?: {
                setMethodResponse: (method: string, payload: unknown) => void;
              };
            }
          ).openclawControlUiE2eGateway;
          if (!gateway) {
            throw new Error("Mock Gateway is not installed");
          }
          gateway.setMethodResponse(targetMethod, responsePayload);
        },
        { targetMethod: method, responsePayload: payload },
      );
    },
    async setSessionSharingPolicy(policy) {
      await page.evaluate((nextPolicy) => {
        const gateway = (
          window as Window & {
            openclawControlUiE2eGateway?: {
              setSessionSharingPolicy: (policy: typeof nextPolicy) => void;
            };
          }
        ).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setSessionSharingPolicy(nextPolicy);
      }, policy);
    },
    async waitForRequest(method, options) {
      const deadline = Date.now() + controlUiE2eWaitTimeoutMs;
      const after = options?.after;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await page.waitForFunction(
            ({ targetMethod, priorCount }) => {
              const gateway = (
                window as Window & {
                  openclawControlUiE2eGateway?: {
                    requests: MockGatewayRequest[];
                  };
                }
              ).openclawControlUiE2eGateway;
              const matching =
                gateway?.requests.filter((request) => request.method === targetMethod) ?? [];
              return matching.length > (priorCount ?? 0);
            },
            { targetMethod: method, priorCount: after ?? 0 },
            // Request capture is non-rendering state. Interval polling avoids background-page
            // requestAnimationFrame throttling when CI runs several headless pages concurrently.
            { polling: 25, timeout: Math.max(1, deadline - Date.now()) },
          );
          const matching = await getRequests(method);
          // With an `after` cursor, return the first NEW request; otherwise keep
          // the historical latest-match behavior existing callers rely on.
          const request = after === undefined ? matching.at(-1) : matching.at(after);
          if (request) {
            return request;
          }
        } catch (error) {
          const contextReset =
            error instanceof Error &&
            (error.message.includes("Execution context was destroyed") ||
              error.message.includes("Cannot find context with specified id"));
          // Intentional stale-build reloads replace the page context once while connecting.
          if (contextReset && attempt === 0 && !page.isClosed()) {
            continue;
          }
          if (error instanceof Error && error.name === "TimeoutError") {
            await captureControlUiE2eFailureDiagnostics(page, {
              error,
              label: method,
              pageEvents: diagnosticEvents,
            });
          }
          throw error;
        }
      }
      throw new Error(`No mock Gateway request found for ${method}`);
    },
  };
}

/**
 * Capture a screenshot plus a browser/app-state report for a failed E2E wait.
 * Wired into mock-Gateway request timeouts automatically; boot/readiness waits
 * in individual tests should call this from their failure path so CI artifacts
 * explain stalls instead of surfacing all-null poll snapshots.
 */
export async function captureControlUiE2eFailureDiagnostics(
  page: Page,
  options: {
    error: Error;
    label: string;
    pageErrors?: string[];
    pageEvents?: ControlUiE2eDiagnosticEvent[];
  },
): Promise<void> {
  try {
    await captureControlUiE2eFailureDiagnosticsUnsafe(page, options);
  } catch (captureError) {
    console.error("[control-ui-e2e] failed to capture failure diagnostics", {
      captureError,
      label: options.label,
    });
  }
}

async function captureControlUiE2eFailureDiagnosticsUnsafe(
  page: Page,
  {
    error,
    label,
    pageErrors = [],
    // The mock-Gateway installer keeps a per-page diagnostic ring; default to
    // it so ad-hoc test callers get console/navigation history for free.
    pageEvents = controlUiE2ePageDiagnostics.get(page) ?? [],
  }: {
    error: Error;
    label: string;
    pageErrors?: string[];
    pageEvents?: ControlUiE2eDiagnosticEvent[];
  },
): Promise<void> {
  const configuredDir = process.env.OPENCLAW_UI_E2E_DIAGNOSTIC_DIR?.trim();
  const artifactDir = path.resolve(
    configuredDir || path.join(resolveRepoRoot(), ".artifacts", "control-ui-e2e-timeouts", "local"),
  );
  mkdirSync(artifactDir, { recursive: true });
  const safeMethod = label.replaceAll(/[^a-zA-Z0-9_.-]+/gu, "-");
  const captureId = `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${String(++controlUiE2eDiagnosticSequence).padStart(2, "0")}-${safeMethod}`;
  const screenshotName = `${captureId}.png`;
  const screenshotPath = path.join(artifactDir, screenshotName);
  const reportPath = path.join(artifactDir, `${captureId}.json`);
  const captureErrors: string[] = [];
  let browserState: unknown = null;
  try {
    browserState = await page.evaluate(() => {
      const copy = (value: unknown): unknown => {
        try {
          return structuredClone(value) as unknown;
        } catch {
          return String(value);
        }
      };
      type Runtime = {
        context?: {
          agents?: {
            state?: {
              agentsError?: unknown;
              agentsList?: unknown;
              agentsLoading?: unknown;
              connected?: unknown;
            };
          };
          agentSelection?: { state?: unknown };
          gateway?: { snapshot?: { assistantAgentId?: unknown; hello?: unknown; phase?: unknown } };
          router?: { getState?: () => unknown };
        };
        router?: { getState?: () => unknown };
      };
      type MockGateway = {
        requests?: MockGatewayRequest[];
        socketStates?: () => Array<{ readyState: number; state: string; url: string }>;
        socketUrls?: () => string[];
      };
      const windowState = window as Window & {
        __OPENCLAW_CONTROL_UI_E2E_UNHANDLED_REJECTIONS__?: unknown[];
        openclawControlUiE2eGateway?: MockGateway;
      };
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & { runtime?: Runtime })
        | null;
      const shell = document.querySelector("openclaw-app-shell") as
        | (HTMLElement & { runtime?: Runtime })
        | null;
      const runtime = app?.runtime ?? shell?.runtime;
      const context = runtime?.context;
      const agentsState = context?.agents?.state;
      const gatewaySnapshot = context?.gateway?.snapshot;
      const routerState = runtime?.router?.getState?.() ?? context?.router?.getState?.();
      const summarizeMatches = (matches: unknown): unknown =>
        Array.isArray(matches)
          ? matches.map((match) => {
              if (!match || typeof match !== "object") {
                return copy(match);
              }
              const record = match as Record<string, unknown>;
              return {
                pathname: copy(record.pathname ?? record.path ?? null),
                routeId: copy(record.routeId ?? record.id ?? null),
              };
            })
          : copy(matches ?? []);
      const customElementCounts: Record<string, number> = {};
      for (const element of document.querySelectorAll("*")) {
        const name = element.localName;
        if (!name.includes("-")) {
          continue;
        }
        customElementCounts[name] = (customElementCounts[name] ?? 0) + 1;
      }
      return {
        app: {
          agentSelection: copy(context?.agentSelection?.state ?? null),
          gateway: {
            assistantAgentId: copy(gatewaySnapshot?.assistantAgentId ?? null),
            hello: copy(gatewaySnapshot?.hello ?? null),
            phase: copy(gatewaySnapshot?.phase ?? null),
          },
          roster: {
            agentsError: copy(agentsState?.agentsError ?? null),
            agentsList: copy(agentsState?.agentsList ?? null),
            agentsLoading: copy(agentsState?.agentsLoading ?? null),
            connected: copy(agentsState?.connected ?? null),
          },
          router:
            routerState && typeof routerState === "object"
              ? {
                  matches: summarizeMatches((routerState as { matches?: unknown }).matches),
                  pendingMatches: summarizeMatches(
                    (routerState as { pendingMatches?: unknown }).pendingMatches,
                  ),
                  resolvedLocation: copy(
                    (routerState as { resolvedLocation?: unknown }).resolvedLocation ?? null,
                  ),
                  status: copy((routerState as { status?: unknown }).status ?? null),
                }
              : copy(routerState ?? null),
        },
        document: {
          customElementCounts,
          hasApp: Boolean(app),
          hasShell: Boolean(shell),
          readyState: document.readyState,
          // A stalled or failed bundle fetch shows as a script src with no
          // matching completed resource entry (resource timing only records
          // finished requests).
          completedResources: performance
            .getEntriesByType("resource")
            .filter((entry) => /\.(?:js|css)(?:\?|$)/u.test(entry.name))
            .map((entry) => ({
              duration: Math.round(entry.duration),
              name: entry.name,
            })),
          scripts: [...document.scripts].map((script) => script.src || "(inline)"),
          serviceWorkerController: navigator.serviceWorker?.controller?.state ?? null,
          title: document.title,
          url: window.location.href,
        },
        mockGateway: {
          installed: Boolean(windowState.openclawControlUiE2eGateway),
          requests: copy(windowState.openclawControlUiE2eGateway?.requests ?? []),
          socketStates: copy(windowState.openclawControlUiE2eGateway?.socketStates?.() ?? []),
          socketUrls: copy(windowState.openclawControlUiE2eGateway?.socketUrls?.() ?? []),
        },
        unhandledRejections: copy(
          windowState["__OPENCLAW_CONTROL_UI_E2E_UNHANDLED_REJECTIONS__"] ?? [],
        ),
      };
    });
  } catch (evaluateError) {
    captureErrors.push(`page.evaluate: ${String(evaluateError)}`);
  }
  let screenshotWritten = false;
  try {
    await page.screenshot({ fullPage: true, path: screenshotPath });
    screenshotWritten = true;
  } catch (screenshotError) {
    captureErrors.push(`page.screenshot: ${String(screenshotError)}`);
  }
  const report = {
    schemaVersion: 2,
    label,
    browserState,
    captureErrors,
    capturedAt: new Date().toISOString(),
    ci: {
      githubJob: process.env.GITHUB_JOB ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null,
      shardIndex: process.env.SHARD_INDEX ?? null,
      vitestShardCount: process.env.VITEST_SHARD_COUNT ?? null,
    },
    pageEvents: [...pageEvents],
    pageErrors: [...pageErrors],
    page: {
      closed: page.isClosed(),
      url: page.url(),
    },
    screenshot: screenshotWritten ? screenshotName : null,
    failure: {
      message: error.message,
      name: error.name,
      stack: error.stack ?? null,
    },
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.error(`[control-ui-e2e] failure diagnostics: ${reportPath}`);
  if (screenshotWritten) {
    console.error(`[control-ui-e2e] failure screenshot: ${screenshotPath}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, outDir] = process.argv.slice(2);
  if (command !== "--production-build" || !outDir) {
    throw new Error("Usage: control-ui-e2e.ts --production-build <out-dir>");
  }
  await runProductionControlUiBuild(outDir);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
