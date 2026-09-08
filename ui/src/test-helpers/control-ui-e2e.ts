// Control UI test helper supports control ui e2e setup.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HelloOk } from "@openclaw/gateway-protocol";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { ConsoleMessage, Frame, Locator, Page, Request } from "playwright";
import type { InlineConfig, Plugin, PreviewServer, ViteDevServer } from "vite";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-contract.js";
import { controlUiPluginAssetRoot } from "../../../src/gateway/control-ui-plugin-assets-contract.js";
import type {
  AgentsListResult,
  ModelCatalogEntry,
  UpdateAvailable,
  UpdateScheduleState,
} from "../api/types.ts";
import type { AuthenticatedUser } from "../app/user-profile.ts";
import { normalizeControlUiBuildInfo } from "../build-info-normalizers.ts";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { createControlUiE2eArtifactDir } from "./control-ui-e2e-artifacts.ts";
import type { NativeControlUiPluginFixture } from "./control-ui-plugin-fixture.ts";
import {
  createControlUiSessionFixtures,
  type ControlUiSessionFixture,
} from "./control-ui-session-fixtures.ts";

export function controlUiSessionPath(
  sessionKey: string,
  basePath = "",
  namespace: "chat" | "dashboard" = "chat",
): string {
  return (
    buildControlUiSessionPath({
      namespace,
      sessionKey,
      fallbackAgentId: sessionKey.split(":")[1] || "main",
      basePath,
    }) ?? `${basePath}/chat`
  );
}

export function controlUiSessionUrl(
  baseUrl: string,
  sessionKey: string,
  namespace: "chat" | "dashboard" = "chat",
): string {
  const url = new URL(baseUrl);
  // Cold fixture navigation knows the exact key; it must not depend on a warm
  // short-reference cache or a separately mocked sessions.resolve response.
  url.pathname =
    buildControlUiSessionPath({
      namespace,
      sessionKey,
      basePath: url.pathname,
      fallbackAgentId: sessionKey.split(":")[1] || "main",
      exactKey: true,
    }) ?? controlUiSessionPath(sessionKey, url.pathname, namespace);
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function navigateToControlUiSession(page: Page, sessionKey: string): Promise<void> {
  const expectedPathname = await page.evaluate((sessionPath) => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime?: {
        context: {
          basePath: string;
          navigate: (routeId: string, options: { pathname: string }) => void;
        };
      };
    };
    if (!app.runtime) {
      throw new Error("OpenClaw application runtime is unavailable");
    }
    const pathname = `${app.runtime.context.basePath}${sessionPath}`;
    const url = new URL(window.location.href);
    url.pathname = pathname;
    app.runtime.context.navigate("chat", { pathname });
    return url.pathname;
  }, controlUiSessionPath(sessionKey));
  await page.waitForURL((url) => url.pathname === expectedPathname);
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

export function createControlUiMockSameOriginGatewayScript(): string {
  return `;(${installControlUiMockSameOriginGateway.toString()})();`;
}

function installControlUiMockSameOriginGateway() {
  // Standalone mock pages emulate Gateway-served UI so same-origin security
  // checks exercise package assets instead of falling back to initials.
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  (
    window as Window & {
      ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: { gatewayUrl: string };
    }
  )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
    gatewayUrl: `${protocol}//${window.location.host}`,
  };
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
        const app = document.querySelector<
          HTMLElement & {
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
          }
        >("openclaw-app");
        // Native popup events can arrive before the app element is parsed.
        const state = app?.runtime?.router.getState();
        const pathname = window.location.pathname;
        // Router paths retain literal characters that browser history percent-encodes.
        // Serialize as a pathname; decoding would alias encoded delimiters and percent data.
        const browserPathname = (value: string) => {
          const url = new URL(window.location.href);
          url.pathname = value;
          return url.pathname;
        };
        return (
          state?.status === "success" &&
          state.matches[0]?.routeId === expected.routeId &&
          state.resolvedLocation !== null &&
          browserPathname(state.resolvedLocation.pathname) === pathname &&
          state.pendingMatches.length === 0 &&
          (expected.pathname === undefined || pathname === browserPathname(expected.pathname)) &&
          (expected.pathnamePrefix === undefined ||
            pathname.startsWith(browserPathname(expected.pathnamePrefix))) &&
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
      const app = document.querySelector<
        HTMLElement & {
          runtime?: {
            router: {
              getState: () => unknown;
            };
          };
        }
      >("openclaw-app");
      return {
        hash: window.location.hash,
        pathname: window.location.pathname,
        router: app?.runtime?.router.getState() ?? null,
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
 * Click a control inside a board widget document once pointer events reach it.
 *
 * Board widget frames stay `inert` and transparent until the sandbox reports
 * the document rendered, and Linux Chromium keeps routing pointer events to the
 * outer iframe element instead of into the revealed cross-origin document until
 * that reveal reaches its compositor. Playwright's actionability checks read the
 * DOM, and its hit-target interceptor reports a click that reached no frame as
 * delivered, so a click issued in that window is a silent no-op. Hover until the
 * widget document itself observes the pointer, then click; a control that never
 * observes it fails loudly instead.
 */
export async function clickBoardWidgetControl(page: Page, control: Locator): Promise<void> {
  const deadline = Date.now() + controlUiE2eWaitTimeoutMs;
  for (;;) {
    // Leave and re-enter: a stationary pointer keeps the browser's stale
    // routing decision, while a fresh move re-runs hit testing.
    await page.mouse.move(0, 0);
    await control.hover();
    if (await control.evaluate((element) => element.matches(":hover"))) {
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error("Board widget control never received pointer events.");
    }
    await page.waitForTimeout(100);
  }
  await control.click();
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
  "config.schema",
  "config.set",
  "device.scopes.requestUpgrade",
  "device.scopes.waitUpgrade",
  "session.members.add",
  "session.members.list",
  "session.members.listEvidence",
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
  "sessions.search",
  "users.github.status",
  "users.github.authorize.start",
  "users.github.authorize.poll",
  "users.github.authorize.cancel",
  "users.github.disconnect",
  "sessions.github.options",
  "sessions.github.status",
  "sessions.github.confirm",
  "tools.github.status",
  "tools.github.configure",
  "tools.github.authorize.start",
  "tools.github.authorize.poll",
  "tools.github.authorize.cancel",
  "update.hold",
  "update.run",
  "update.runs.get",
  "update.runs.list",
  "update.status",
  "worktrees.branches",
] as const;

export type MockGatewayRequest = {
  id: string;
  method: string;
  params?: unknown;
};

export type ControlUiMockGatewayScenario = {
  nativePlugins?: readonly NativeControlUiPluginFixture[];
  pluginAssetsRequireAuth?: boolean;
  attachmentMaxBytes?: number;
  agentModel?: string | null;
  assistantAgentId?: string;
  assistantName?: string;
  automaticallyFetchFavicons?: boolean;
  communityInvite?: boolean;
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
  /** Hold every request until resolveDeferred/rejectDeferred releases the method. */
  heldMethods?: string[];
  /** Non-release gateway checkout branch surfaced in the sidebar footer. */
  devGitBranch?: string;
  /** Exact immutable Control UI artifact served by the mocked Gateway. */
  serverBuildId?: string;
  /** Exact Gateway lifecycle generation served in hello. */
  gatewayBootId?: string;
  gatewaySuspensionPhase?: "accepting" | "preparing" | "draining" | "prepared";
  /** Optional startup update snapshot for rich local mock fixtures. */
  updateAvailable?: UpdateAvailable | null;
  /** Optional automatic-update campaign snapshot for rich local mock fixtures. */
  updateSchedule?: UpdateScheduleState | null;
  controlUiBuildSource?: "bundled" | "configured";
  serverVersion?: string;
  deviceToken?: string;
  authMethod?: HelloOk["auth"]["method"];
  authMode?: HelloOk["snapshot"]["authMode"] | null;
  featureMethods?: string[];
  /** Simulate a legacy Gateway that predates the advertised method catalog. */
  omitFeatureMethods?: boolean;
  historyMessages?: unknown[];
  /** Canonical per-session transcripts, shared by history and startup reads. */
  sessionTranscripts?: Record<
    string,
    {
      messages: unknown[];
      thinkingLevel?: string | null;
      inFlightRun?: ControlUiMockGatewayScenario["inFlightRun"];
    }
  >;
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
    identity?: AuthenticatedUser["identity"];
    name?: string;
    email?: string;
    avatarUrl?: string;
    deviceFamily?: string;
    host?: string;
    ip?: string;
    instanceId?: string;
    lastInputSeconds?: number;
    onlineSince?: number;
    lastActivityAt?: number;
    timeZone?: string;
    mode?: string;
    platform?: string;
    ts?: number;
    watchedSessions?: string[];
  }>;
  /** Subscription-scoped Gateway events replayed on a fixed browser-side cycle. */
  repeatingSessionEvents?: {
    events: Array<{ event: "agent" | "session.observer" | "session.tool"; payload: unknown }>;
    intervalMs?: number;
  };
  /** Explicit history-only row override, for example a stale run-state projection. */
  sessionInfo?: Record<string, unknown> | null;
  /** Canonical fixture rows, independent of case/sequence/deferred wire overrides. */
  sessions?: ControlUiSessionFixture[];
  /** Partition sessions.list fixtures by archived state after applying patches. */
  sessionArchiveFiltering?: boolean;
  models?: ModelCatalogEntry[];
  /** Simulate a legacy Gateway whose connect hello predates the auth projection. */
  omitConnectHelloAuth?: boolean;
  /** Operator scopes returned by the mocked connect handshake. */
  operatorScopes?: string[];
  /** Selected fixture and event default; use controlUiSessionUrl to select it in the UI. */
  sessionKey?: string;
  sessionScope?: AgentsListResult["scope"];
  mainSessionKey?: string;
  /** Initial gateway-owned custom group catalog (sessions.groups.*), in order. */
  sessionGroups?: string[];
  /** Optional New Session defaults keyed by custom group name. */
  sessionGroupDefaults?: Record<string, { cwd?: string; worktree?: boolean }>;
  terminalEnabled?: boolean;
  cliAgentsEnabled?: boolean;
  workspace?: string;
  workspaceGit?: boolean;
};

type NormalizedControlUiMockGatewayScenario = Required<
  Omit<ControlUiMockGatewayScenario, "nativePlugins">
>;

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

type MockSessionsListResponse = { sessions: unknown[]; [field: string]: unknown };

export type MockGatewayControls = {
  closeLatest: (code?: number, reason?: string) => Promise<void>;
  deliverLatest: (frame: unknown) => Promise<void>;
  deferNext: (method: string, match?: Record<string, unknown>) => Promise<void>;
  emitChatFinal: (params: { runId: string; sessionKey?: string; text: string }) => Promise<void>;
  emitGatewayEvent: (event: string, payload?: unknown) => Promise<void>;
  getRequests: (method?: string, match?: Record<string, unknown>) => Promise<MockGatewayRequest[]>;
  getSocketCount: () => Promise<number>;
  getSocketUrls: () => Promise<string[]>;
  rejectDeferred: (
    method: string,
    error?: { code?: string; message?: string; details?: unknown; retryable?: boolean },
  ) => Promise<void>;
  resolveDeferred: (method: string, payload?: unknown) => Promise<void>;
  suspendLatest: () => Promise<void>;
  setOnline: (online: boolean) => Promise<void>;
  setGatewayBootId: (bootId: string) => Promise<void>;
  setServerBuildId: (buildId: string) => Promise<void>;
  setOperatorScopes: (scopes: string[]) => Promise<void>;
  setHistoryMessages: (messages: unknown[]) => Promise<void>;
  setMethodResponse: (method: string, payload: unknown) => Promise<void>;
  setSessionsListResponse: (payload: MockSessionsListResponse) => Promise<void>;
  setSessionSharingPolicy: (policy: {
    allowedSessionVisibilities: Array<"shared" | "read-only" | "suggest" | "draft">;
    hasMultipleSessionSharingIdentities: boolean;
  }) => Promise<void>;
  /**
   * Resolves with a captured request for `method`. Without `after` this is
   * satisfied by ANY prior request of the method (and returns the latest), so
   * a second same-method wait can return a stale earlier request on slow
   * runners; pass `after` = the pre-action count from `getRequests(method, match)`
   * to wait for and return the next new request in that same parameter scope.
   */
  waitForRequest: (
    method: string,
    options?: { after?: number; match?: Record<string, unknown> },
  ) => Promise<MockGatewayRequest>;
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
    communityInvite: true,
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
      // Forward build activity while spawnSync waits; retain stderr for failures.
      stdio: ["ignore", "inherit", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Production Control UI build failed (exit ${result.status ?? "unknown"}):\n${result.stderr || result.error?.message || "See streamed build output above."}`,
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
    logLevel: "info",
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
  await build({
    ...createBundledControlUiE2eConfig(controlUiViteConfig, outDir),
    logLevel: "info",
  });
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
  const defaultAgentId = normalizeAgentId(scenario.defaultAgentId);
  const mainSessionKey =
    scenario.mainSessionKey?.trim() ||
    (scenario.sessionScope === "global" ? "global" : `agent:${defaultAgentId}:main`);
  const sessionKey = scenario.sessionKey?.trim() || mainSessionKey;
  const staticList = scenario.methodResponses?.["sessions.list"] as
    | { sessions?: ControlUiSessionFixture[] }
    | undefined;
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
    pluginAssetsRequireAuth: scenario.pluginAssetsRequireAuth ?? true,
    attachmentMaxBytes: scenario.attachmentMaxBytes ?? DEFAULT_MOCK_ATTACHMENT_MAX_BYTES,
    automaticallyFetchFavicons: scenario.automaticallyFetchFavicons ?? false,
    communityInvite: scenario.communityInvite ?? true,
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
    heldMethods: scenario.heldMethods ?? [],
    devGitBranch: scenario.devGitBranch?.trim() || "",
    serverBuildId: scenario.serverBuildId?.trim() || "e2e",
    gatewayBootId: scenario.gatewayBootId?.trim() || "e2e-gateway-boot",
    gatewaySuspensionPhase: scenario.gatewaySuspensionPhase ?? "accepting",
    updateAvailable: scenario.updateAvailable ?? null,
    updateSchedule: scenario.updateSchedule ?? null,
    controlUiBuildSource: scenario.controlUiBuildSource ?? "bundled",
    serverVersion: scenario.serverVersion?.trim() || "e2e",
    deviceToken: scenario.deviceToken?.trim() || "e2e-device-token",
    authMethod: scenario.authMethod ?? "token",
    authMode: scenario.authMode ?? null,
    // Baseline scenarios represent a current Gateway. Tests for unsupported or
    // mixed-version methods provide an explicit narrower catalog.
    featureMethods: scenario.featureMethods ?? [...defaultControlUiFeatureMethods],
    omitFeatureMethods: scenario.omitFeatureMethods ?? false,
    historyMessages: scenario.historyMessages ?? [],
    sessionTranscripts: scenario.sessionTranscripts ?? {},
    maxPayload: scenario.maxPayload ?? DEFAULT_MOCK_MAX_PAYLOAD_BYTES,
    mainSessionKey,
    methodResponses: scenario.methodResponses ?? {},
    webSocketPassthroughPrefixes: scenario.webSocketPassthroughPrefixes ?? [],
    inFlightRun: scenario.inFlightRun ?? null,
    presenceUsers: scenario.presenceUsers ?? [],
    models: scenario.models ?? [{ id: "gpt-5.5", name: "gpt-5.5", provider: "openai" }],
    omitConnectHelloAuth: scenario.omitConnectHelloAuth ?? false,
    operatorScopes: scenario.operatorScopes ?? [
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
    ],
    repeatingSessionEvents: scenario.repeatingSessionEvents ?? { events: [] },
    sessionInfo: scenario.sessionInfo ?? null,
    sessions:
      scenario.sessions ??
      staticList?.sessions ??
      (staticList
        ? []
        : [
            {
              key: sessionKey === "main" ? mainSessionKey : sessionKey,
              label: "Main",
              kind:
                (sessionKey === "main" ? mainSessionKey : sessionKey) === "global"
                  ? "global"
                  : "direct",
              updatedAt: Date.now(),
            },
          ]),
    sessionArchiveFiltering: scenario.sessionArchiveFiltering ?? false,
    sessionKey,
    sessionScope: scenario.sessionScope ?? "per-sender",
    sessionGroups: scenario.sessionGroups ?? [],
    sessionGroupDefaults: scenario.sessionGroupDefaults ?? {},
    terminalEnabled: scenario.terminalEnabled ?? false,
    cliAgentsEnabled: scenario.cliAgentsEnabled ?? false,
    workspace: scenario.workspace ?? "",
    workspaceGit: scenario.workspaceGit ?? false,
  };
}

export function createControlUiMockBootstrapConfig(scenario: ControlUiMockGatewayScenario = {}) {
  const normalizedScenario = normalizeScenario(scenario);
  const nativeCatalog = normalizedScenario.methodResponses["plugins.controlUi.list"] as
    | { plugins?: { pluginId: string }[] }
    | undefined;
  return {
    pluginAssetsRequireAuth: normalizedScenario.pluginAssetsRequireAuth,
    pluginFrameGrants: (normalizedScenario.pluginAssetsRequireAuth
      ? (nativeCatalog?.plugins ?? [])
      : []
    ).map(({ pluginId }) => ({
      pluginId,
      path: `/__openclaw__/plugins/control-ui/${encodeURIComponent(pluginId)}/`,
      match: "prefix",
    })),
    allowExternalEmbedUrls: false,
    automaticallyFetchFavicons: normalizedScenario.automaticallyFetchFavicons,
    communityInvite: normalizedScenario.communityInvite,
    assistantAgentId: normalizedScenario.assistantAgentId,
    assistantAvatar: "",
    assistantName: normalizedScenario.assistantName,
    basePath: normalizedScenario.basePath,
    devGitBranch: normalizedScenario.devGitBranch || undefined,
    embedSandbox: "scripts",
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
  return `${json5BrowserSource}\n;(() => { const __name = (target) => target; (${installControlUiMockGateway.toString()})(${JSON.stringify(input)}, globalThis.JSON5.parse, ${createControlUiSessionFixtures.toString()}); })();`;
}

export type ControlUiMockRequestHandler = (request: {
  params: unknown;
  respond: (payload: unknown) => void;
  emit: (event: string, payload: unknown) => void;
}) => void;

export type ControlUiMockGateway = {
  closeLatest: (code?: number, reason?: string) => void;
  deliverLatest: (frame: unknown) => void;
  deferNext: (method: string, match?: Record<string, unknown>) => void;
  emit: (event: string, payload?: unknown) => void;
  findRequests: (method?: string, match?: Record<string, unknown>) => MockGatewayRequest[];
  rejectDeferred: (
    method: string,
    error?: { code?: string; message?: string; details?: unknown; retryable?: boolean },
  ) => void;
  requests: MockGatewayRequest[];
  resolveDeferred: (method: string, payload?: unknown) => void;
  suspendLatest: () => void;
  setOnline: (online: boolean) => void;
  setGatewayBootId: (bootId: string) => void;
  setServerBuildId: (buildId: string) => void;
  setOperatorScopes: (scopes: string[]) => void;
  setHistoryMessages: (messages: unknown[]) => void;
  setMethodResponse: (method: string, payload: unknown) => void;
  setSessionsListResponse: (payload: MockSessionsListResponse) => void;
  setRequestHandler: (method: string, handler: ControlUiMockRequestHandler) => void;
  setSessionSharingPolicy: (policy: {
    allowedSessionVisibilities: Array<"shared" | "read-only" | "suggest" | "draft">;
    hasMultipleSessionSharingIdentities: boolean;
  }) => void;
  socketCount: () => number;
  socketStates: () => Array<{ readyState: number; state: string; url: string }>;
  socketUrls: () => string[];
};
type MockGatewayWindow = Window & {
  __OPENCLAW_CONTROL_UI_BASE_PATH__?: string;
  openclawControlUiE2eGateway?: ControlUiMockGateway;
};

function installControlUiMockGateway(
  input: {
    protocolVersion: number;
    scenario: NormalizedControlUiMockGatewayScenario;
  },
  parseJson5: (raw: string) => unknown,
  createSessions: typeof createControlUiSessionFixtures,
) {
  const NativeWebSocket = window.WebSocket;
  type BrowserFrame = {
    id?: unknown;
    method?: unknown;
    params?: unknown;
    type?: unknown;
  };
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

  const scenario = input.scenario;
  const serverBuildIdStateKey = "openclaw.control-ui-e2e.serverBuildId";
  let serverBuildId = scenario.serverBuildId;
  let gatewayBootId =
    new URL(window.location.href).searchParams.get("mockGatewayBootId")?.trim() ||
    scenario.gatewayBootId;
  try {
    serverBuildId = window.sessionStorage.getItem(serverBuildIdStateKey)?.trim() || serverBuildId;
  } catch {
    // The scenario value remains authoritative when browser storage is unavailable.
  }
  (window as MockGatewayWindow)["__OPENCLAW_CONTROL_UI_BASE_PATH__"] = scenario.basePath;
  const protocolVersion = input.protocolVersion;
  const methodResponseOverridesStorageKey = "openclaw.control-ui-e2e.method-responses.v1";
  const canonicalSessionsStorageKey = "openclaw.control-ui-e2e.canonical-sessions.v1";
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
  const heldMethods = new Set(scenario.heldMethods);
  const deferredResponses: DeferredResponse[] = [];
  const requests: MockGatewayRequest[] = [];
  const requestHandlers = new Map<string, ControlUiMockRequestHandler>();
  const methodResponseSequenceIndexes = new Map<string, number>();
  const pendingApprovals = new Map<string, Map<string, Record<string, unknown>>>();
  let canonicalSessionRows = scenario.sessions;
  let hasCanonicalSessionsOverride = false;
  try {
    const storedCanonicalSessions = window.sessionStorage.getItem(canonicalSessionsStorageKey);
    const parsedCanonicalSessions = storedCanonicalSessions
      ? (JSON.parse(storedCanonicalSessions) as unknown)
      : null;
    if (Array.isArray(parsedCanonicalSessions)) {
      canonicalSessionRows = parsedCanonicalSessions as ControlUiSessionFixture[];
      hasCanonicalSessionsOverride = true;
    }
  } catch {
    // The scenario remains authoritative when browser storage is unavailable.
  }
  const sessions = createSessions({
    rows: canonicalSessionRows,
    mainKey: scenario.mainSessionKey,
  });
  if (hasCanonicalSessionsOverride) {
    // Persisted explicit snapshots bypass scenario-default enrichment so reload
    // preserves the same exact owner rows used by CAS, describe, and startup.
    sessions.replaceCanonicalList(canonicalSessionRows);
  }
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
    return value;
  }

  type CommittedChatInput = {
    sessionId: string;
    runId: string;
    message: Record<string, unknown> & { __openclaw: { id: string; seq: number } };
  };
  const chatInputsStorageKey = "openclaw.control-ui-e2e.chatInputs";
  let committedChatInputs: CommittedChatInput[] = [];
  let historyMessagesOverridden = false;
  try {
    const stored = window.sessionStorage.getItem(chatInputsStorageKey);
    if (stored) {
      committedChatInputs = JSON.parse(stored) as CommittedChatInput[];
    }
  } catch {
    // The current page's mock still works without persistent browser storage.
  }

  function sourceIdempotencyKey(message: unknown): unknown {
    if (!isRecord(message) || message.role !== "user") {
      return undefined;
    }
    const metadata = isRecord(message["__openclaw"]) ? message["__openclaw"] : undefined;
    return metadata?.idempotencyKey ?? message.idempotencyKey;
  }

  function messageSequence(message: unknown): number {
    const metadata =
      isRecord(message) && isRecord(message["__openclaw"]) ? message["__openclaw"] : null;
    return typeof metadata?.seq === "number" && Number.isSafeInteger(metadata.seq)
      ? metadata.seq
      : 0;
  }

  function chatHistoryMessages(key: string): unknown[] {
    const row = sessions.read(key);
    const messages = [
      ...(scenario.sessionTranscripts[row.key]?.messages ?? scenario.historyMessages),
    ];
    if (historyMessagesOverridden && !scenario.sessionTranscripts[row.key]) {
      return messages;
    }
    for (const source of committedChatInputs.filter((entry) => entry.sessionId === row.sessionId)) {
      if (messages.some((message) => sourceIdempotencyKey(message) === `${source.runId}:user`)) {
        continue;
      }
      const next = messages.findIndex(
        (message) => messageSequence(message) > source.message["__openclaw"].seq,
      );
      messages.splice(next < 0 ? messages.length : next, 0, source.message);
    }
    return messages;
  }

  function commitDefaultChatInput(params: unknown): CommittedChatInput | undefined {
    if (
      !isRecord(params) ||
      typeof params.idempotencyKey !== "string" ||
      typeof params.message !== "string" ||
      (!params.intent && params.message.trimStart().startsWith("/"))
    ) {
      return undefined;
    }
    const row = sessions.read(
      typeof params.sessionKey === "string" ? params.sessionKey : scenario.sessionKey,
    );
    const existing = committedChatInputs.find(
      (entry) => entry.sessionId === row.sessionId && entry.runId === params.idempotencyKey,
    );
    if (existing) {
      return existing;
    }
    const sequence =
      Math.max(
        0,
        ...chatHistoryMessages(row.key).map(messageSequence),
        ...committedChatInputs
          .filter((source) => source.sessionId === row.sessionId)
          .map((source) => source.message["__openclaw"].seq),
      ) + 1;
    const media = Array.isArray(params.attachments)
      ? params.attachments.filter(isRecord).map((attachment) => ({
          kind:
            typeof attachment.mimeType === "string" && attachment.mimeType.startsWith("image/")
              ? "image"
              : "file",
          contentType: attachment.mimeType,
          fileName: attachment.fileName,
          url: `data:${typeof attachment.mimeType === "string" ? attachment.mimeType : "application/octet-stream"};base64,${typeof attachment.content === "string" ? attachment.content : ""}`,
        }))
      : [];
    const source: CommittedChatInput = {
      sessionId: String(row.sessionId),
      runId: params.idempotencyKey,
      message: {
        role: "user",
        content: params.message,
        timestamp: Date.now(),
        idempotencyKey: `${params.idempotencyKey}:user`,
        __openclaw: {
          id: `mock-user:${params.idempotencyKey}`,
          seq: sequence,
          ...(media.length ? { media } : {}),
          ...(Array.isArray(params.mentions) ? { humanMentions: params.mentions } : {}),
          ...(typeof params.replyToId === "string" ? { replyToId: params.replyToId } : {}),
        },
      },
    };
    committedChatInputs.push(source);
    if (media.length) {
      // Attachment turns ACK before their source receipt; publish actual source
      // consumption as a separate event after the response reaches the browser.
      window.queueMicrotask(() => {
        emitGatewayEvent(MockWebSocket.latest, "session.message", {
          sessionKey: row.key,
          sessionId: row.sessionId,
          clientRunId: source.runId,
          messageId: source.message["__openclaw"].id,
          messageSeq: source.message["__openclaw"].seq,
          message: source.message,
        });
      });
    }
    try {
      window.sessionStorage.setItem(chatInputsStorageKey, JSON.stringify(committedChatInputs));
    } catch {
      // Committed fixture source remains available in the current page.
    }
    return source;
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
        instanceId: user.self ? selfInstanceId : (user.instanceId ?? `e2e-presence-${index}`),
        mode: user.mode ?? "webchat",
        reason: "connect",
        ts: user.ts ?? Date.now(),
        ...(user.host ? { host: user.host } : {}),
        ...(user.ip ? { ip: user.ip } : {}),
        ...(user.platform ? { platform: user.platform } : {}),
        ...(user.deviceFamily ? { deviceFamily: user.deviceFamily } : {}),
        ...(user.lastInputSeconds === undefined ? {} : { lastInputSeconds: user.lastInputSeconds }),
        ...(user.onlineSince === undefined ? {} : { onlineSince: user.onlineSince }),
        ...(user.lastActivityAt === undefined ? {} : { lastActivityAt: user.lastActivityAt }),
        ...(user.timeZone ? { timeZone: user.timeZone } : {}),
        user: {
          id: user.id,
          ...(user.identity ? { identity: user.identity } : {}),
          name: user.name ?? null,
          email: user.email ?? null,
          avatarUrl: user.avatarUrl ?? null,
        },
        watchedSessions: user.watchedSessions ?? [],
      })),
    };
  }

  function recordSessionsPatchMany(params: unknown, response: unknown): unknown {
    if (!isRecord(params) || !Array.isArray(params.targets) || !isRecord(params.patch)) {
      return response;
    }
    const patch = params.patch;
    const outcomes =
      isRecord(response) && Array.isArray(response.outcomes) ? response.outcomes : null;
    return {
      ...(isRecord(response) ? response : {}),
      outcomes: params.targets.map((target, index) => {
        if (!isRecord(target) || typeof target.key !== "string") {
          return outcomes?.[index];
        }
        const outcome = outcomes?.[index];
        if (outcomes && (!isRecord(outcome) || outcome.ok !== true)) {
          return outcome;
        }
        const result = sessions.patch(target.key, patch);
        // Explicit outcomes remain wire injections; generated outcomes report the
        // same validation that decides whether the canonical row was committed.
        return (
          outcome ?? {
            key: target.key,
            ...(typeof target.agentId === "string" ? { agentId: target.agentId } : {}),
            ...("__mockError" in result
              ? { ok: false, error: result["__mockError"] }
              : { ok: true }),
          }
        );
      }),
    };
  }

  // Immediate and explicitly resolved deferred replies share one commit point.
  // Wire errors and rejected deferrals must leave canonical fixture state untouched.
  function commitFixtureResponse(method: string, params: unknown, response: unknown): unknown {
    if (isRecord(response) && (response["__mockError"] || response.ok === false)) {
      return response;
    }
    if (
      method === "sessions.catalog.startTerminal" &&
      isRecord(response) &&
      typeof response.sessionId === "string" &&
      typeof response.agentId === "string" &&
      typeof response.shell === "string" &&
      typeof response.cwd === "string" &&
      typeof response.confined === "boolean"
    ) {
      terminalSessions.set(response.sessionId, {
        sessionId: response.sessionId,
        agentId: response.agentId,
        shell: response.shell,
        cwd: response.cwd,
        confined: response.confined,
        attached: true,
        owner: "conn",
        createdAtMs: Date.now(),
        buffer: "",
        seq: 0,
      });
    }
    if (isRecord(params) && typeof params.id === "string") {
      const kind =
        method === "approval.resolve"
          ? params.kind === "system-agent"
            ? "openclaw"
            : params.kind
          : /^(exec|plugin)\.approval\.resolve$/u.exec(method)?.[1];
      if (typeof kind === "string") {
        pendingApprovals.get(`${kind}.approval.list`)?.delete(params.id);
      }
    }
    if (
      (method === "chat.history" || method === "chat.startup") &&
      isRecord(params) &&
      Array.isArray(params.inputRunIds) &&
      isRecord(response) &&
      !hasOwn(response, "inputReceipts")
    ) {
      const info = isRecord(response.sessionInfo) ? response.sessionInfo : undefined;
      const sessionId = info?.sessionId ?? response.sessionId;
      const inputRunIds = params.inputRunIds;
      return {
        ...response,
        inputReceipts: committedChatInputs
          .filter((source) => source.sessionId === sessionId && inputRunIds.includes(source.runId))
          .map((source) => ({
            runId: source.runId,
            state: "consumed",
            consumedByEventId: source.message["__openclaw"].id,
          })),
      };
    }
    if (method === "sessions.patch" && isRecord(params) && typeof params.key === "string") {
      if (
        typeof params.expectedSessionId === "string" &&
        sessions.read(params.key).sessionId !== params.expectedSessionId
      ) {
        return {
          __mockError: {
            code: "INVALID_REQUEST",
            message: "session identity changed; refresh and retry",
          },
        };
      }
      const result = sessions.patch(params.key, params);
      return "__mockError" in result || (isRecord(response) && Object.keys(response).length === 0)
        ? result
        : response;
    }
    if (method === "sessions.patchMany") {
      return recordSessionsPatchMany(params, response);
    }
    if (method === "sessions.create" || method === "sessions.catalog.continue") {
      recordMaterializedSession(params, response);
    }
    return response;
  }

  function emitGatewayEvent(
    socket: { deliver: (frame: unknown) => void } | null,
    event: string,
    payload: unknown,
  ): void {
    const approval = /^(exec|plugin|openclaw)\.approval\.(requested|resolved)$/u.exec(event);
    if (approval && isRecord(payload) && typeof payload.id === "string") {
      // The Gateway registers pending state before publishing its event. A later
      // bootstrap/reconnect list must describe the same approval as the live stream.
      const method = `${approval[1]}.approval.list`;
      const queue = pendingApprovals.get(method) ?? new Map<string, Record<string, unknown>>();
      if (approval[2] === "requested") {
        queue.set(payload.id, payload);
      } else {
        queue.delete(payload.id);
      }
      pendingApprovals.set(method, queue);
    }
    socket?.deliver({ event, payload, seq: ++seq, type: "event" });
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
    sessions.materialize(key, {
      ...(isRecord(response.entry) ? response.entry : {}),
      ...(typeof response.sessionId === "string" ? { sessionId: response.sessionId } : {}),
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
    const projectedSessions = sessions.list(response.sessions).map((row) => {
      if (!isRecord(row)) {
        return row;
      }
      const next = Object.assign({}, row);
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
        ...(sessions.materializedCount() > 0 ? { count: projectedSessions.length } : {}),
        sessions: projectedSessions,
      };
    }
    const filteredSessions = projectedSessions.filter(
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

  function buildResponse(method: string, params: unknown): unknown {
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
      return method === "sessions.list"
        ? applySessionPatches(configuredValue, params)
        : configuredValue;
    }
    switch (method) {
      case "exec.approval.list":
      case "plugin.approval.list":
      case "openclaw.approval.list":
        return [...(pendingApprovals.get(method)?.values() ?? [])].filter(
          (approval) =>
            typeof approval.expiresAtMs === "number" && approval.expiresAtMs > Date.now(),
        );
      case "connect": {
        const auth = isRecord(params) && isRecord(params.auth) ? params.auth : null;
        const connectedDeviceToken =
          auth && typeof auth.deviceToken === "string" ? auth.deviceToken : scenario.deviceToken;
        return {
          ...(scenario.omitConnectHelloAuth
            ? {}
            : {
                auth: {
                  deviceToken: connectedDeviceToken,
                  method: scenario.authMethod,
                  recoveryMigrationAllowed: true as const,
                  recoveryScope: "e2e-recovery-scope",
                  role: "operator",
                  scopes: scenario.operatorScopes,
                },
              }),
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
            bootId: gatewayBootId,
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
            ...(scenario.authMode ? { authMode: scenario.authMode } : {}),
            suspension: { phase: scenario.gatewaySuspensionPhase },
            ...presenceSnapshot(params),
            ...(scenario.updateAvailable ? { updateAvailable: scenario.updateAvailable } : {}),
            ...(scenario.updateSchedule ? { updateSchedule: scenario.updateSchedule } : {}),
            sessionDefaults: {
              defaultAgentId: scenario.defaultAgentId,
              mainKey: "main",
              mainSessionKey: scenario.mainSessionKey,
              modelConfigured: Boolean(scenario.agentModel),
              scope: scenario.sessionScope,
            },
          },
          type: "hello-ok",
        };
      }
      case "sessions.github.options":
        return {
          personal: scenario.presenceUsers.some((user) => user.self)
            ? {
                state: "disconnected",
                generation: null,
                account: null,
                accessExpiresAtMs: null,
                refreshState: "not_applicable",
                pending: null,
              }
            : null,
          shared: { source: "system-configured", accountId: 1, login: "system-bot" },
          pendingPersonal: null,
        };
      case "users.listAuthLinks":
        return { links: [] };
      case "users.listModelAccounts":
        return {
          profileId:
            isRecord(params) && typeof params.profileId === "string"
              ? params.profileId
              : (scenario.presenceUsers.find((user) => user.self)?.id ?? "profile-1"),
          accounts: [],
          links: [],
        };
      case "users.list":
        return { profiles: [] };
      case "users.github.status":
      case "tools.github.status": {
        const system = {
          source: "system-detected",
          credentialKind: "native",
          credentialState: "unavailable",
          account: null,
          gitAuthor: { name: null, email: null },
          evidence: "none",
          accessExpiresAtMs: null,
          refreshState: "not_applicable",
          oauthScopes: [],
          repositoryGrants: "unknown",
        };
        if (method === "users.github.status") {
          return scenario.presenceUsers.some((user) => user.self)
            ? {
                personal: {
                  state: "disconnected",
                  generation: null,
                  account: null,
                  accessExpiresAtMs: null,
                  refreshState: "not_applicable",
                  pending: null,
                },
                system,
              }
            : {
                __mockError: {
                  code: "FORBIDDEN",
                  message:
                    "My GitHub requires a verified durable user profile; sign in and try again.",
                },
              };
        }
        const selectedScope =
          isRecord(params) && params.selectedScope === "agent" ? "agent" : "system";
        return {
          agentId: isRecord(params) ? params.agentId : scenario.defaultAgentId,
          selectedScope,
          selected: {
            scope: selectedScope,
            configured: false,
            identity: selectedScope === "system" ? system : null,
          },
          effective: system,
        };
      }
      case "users.github.authorize.cancel":
      case "tools.github.authorize.cancel":
        return { cancelled: true };
      case "users.github.disconnect":
        return { disconnected: true };
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
          scope: scenario.sessionScope,
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
      case "sessions.resolve":
        return sessions.resolve(isRecord(params) ? params : {});
      case "chat.history":
      case "chat.startup": {
        const resolution =
          method === "chat.startup" && isRecord(params) && typeof params.shortId === "string"
            ? sessions.resolve(params)
            : undefined;
        if (resolution && !resolution.ok) {
          return { resolution, messages: [] };
        }
        const key = resolution?.ok
          ? resolution.key
          : isRecord(params) && typeof params.sessionKey === "string"
            ? params.sessionKey
            : scenario.sessionKey;
        const row = sessions.read(key);
        const info = sessions.sessionInfo(key);
        const override =
          !hasCanonicalSessionsOverride && row.key === sessions.read(scenario.sessionKey).key
            ? scenario.sessionInfo
            : null;
        return {
          ...(resolution ? { resolution } : {}),
          sessionId: row.sessionId,
          ...(info || override ? { sessionInfo: { ...info, ...override } } : {}),
          thinkingLevel: null,
          ...(scenario.inFlightRun ? { inFlightRun: scenario.inFlightRun } : {}),
          ...scenario.sessionTranscripts[row.key],
          messages: chatHistoryMessages(row.key),
          ...(method === "chat.startup"
            ? {
                metadata: { models: scenario.models },
                // Static transcript overrides intentionally replay on startup too.
                ...configuredHistoryTranscript(),
              }
            : {}),
        };
      }
      case "sessions.describe": {
        const key =
          isRecord(params) && typeof params.key === "string" ? params.key : scenario.sessionKey;
        return { session: sessions.sessionInfo(key) ?? null };
      }
      case "chat.metadata":
        return {
          commands: [],
          models: scenario.models,
        };
      case "talk.catalog":
        return {
          modes: [],
          transports: [],
          brains: [],
          speech: { providers: [] },
          transcription: { providers: [] },
          realtime: { ready: true, providers: [] },
        };
      case "chat.send": {
        // The default fixture starts execution. Its original source is canonical
        // before ACK; explicit responses and held requests model other outcomes.
        const source = commitDefaultChatInput(params);
        return {
          runId:
            isRecord(params) && typeof params.idempotencyKey === "string"
              ? params.idempotencyKey
              : "control-ui-e2e-run",
          status: "started",
          ...(source &&
          (!isRecord(params) ||
            !Array.isArray(params.attachments) ||
            params.attachments.length === 0)
            ? {
                messageId: source.message["__openclaw"].id,
                messageSeq: source.message["__openclaw"].seq,
              }
            : {}),
        };
      }
      case "chat.abort":
        return { aborted: true };
      case "skills.proposals.list":
        return {
          schema: "openclaw.skill-workshop.proposals-manifest.v1",
          updatedAt: new Date().toISOString(),
          proposals: [],
          installedSkills: [],
        };
      case "skills.status":
        return {
          workspaceDir: "/tmp/control-ui-mock/workspace",
          managedSkillsDir: "/tmp/control-ui-mock/skills",
          skills: [],
        };
      case "skills.library.list":
        return {
          entries: [],
          profileId: null,
          multipleProfiles: false,
          defaultTarget: "workspace",
          canManageWorkspace: true,
          defaultSelectionLimit: 64,
          ...(isRecord(params) && typeof params.sessionKey === "string"
            ? { session: { sessionKey: params.sessionKey, selections: [], attachable: [] } }
            : {}),
        };
      case "commands.list":
        return { commands: [] };
      case "plugins.list":
        return { plugins: [] };
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
          key: requestedKey || `agent:${agentId}:mock-created-${sessions.materializedCount() + 1}`,
        };
        return response;
      }
      case "sessions.list":
        return applySessionPatches(
          {
            count: sessions.list().length,
            defaults: {
              contextTokens: null,
              model: "gpt-5.5",
              modelProvider: "openai",
            },
            path: "",
            sessions: sessions.list(),
            ts: Date.now(),
          },
          params,
        );
      case "sessions.search":
        return { results: [] };
      case "sessions.patchMany":
        return {};
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
      (method === "terminal.open" || method === "sessions.catalog.startTerminal") &&
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
    if (heldMethods.has(method)) {
      return true;
    }
    const index = deferredMethods.findIndex(
      (candidate) => candidate.method === method && paramsMatch(params, candidate.match),
    );
    if (index < 0) {
      return false;
    }
    deferredMethods.splice(index, 1);
    return true;
  }

  function takeDeferredResponses(method: string): DeferredResponse[] {
    const index = deferredResponses.findIndex((response) => response.method === method);
    if (index < 0) {
      throw new Error(`No deferred mock Gateway response for ${method}`);
    }
    if (!heldMethods.delete(method)) {
      return deferredResponses.splice(index, 1);
    }
    // Startup can replace a request when connection scope settles. A held
    // catalog releases every admitted request, not only its retired predecessor.
    const responses = deferredResponses.filter((response) => response.method === method);
    for (let i = deferredResponses.length - 1; i >= 0; i -= 1) {
      if (deferredResponses[i]?.method === method) {
        deferredResponses.splice(i, 1);
      }
    }
    return responses;
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
      const respond = (response: unknown) => {
        const payload = commitFixtureResponse(method, frame.params, response);
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
      };
      window.setTimeout(() => {
        const handler = requestHandlers.get(method);
        if (handler) {
          // Delayed fixtures retain this request and socket, even when another
          // request for the same method finishes first.
          handler({
            params: frame.params,
            respond,
            emit: (event, payload) => emitGatewayEvent(this, event, payload),
          });
        } else {
          respond(buildResponse(method, frame.params));
        }
      }, 0);
    }

    suspend(): void {
      if (this.tickTimer !== null) {
        window.clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
    }

    deliver(frame: unknown): void {
      if (this.readyState !== MockWebSocket.OPEN) {
        return;
      }
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
    }
  }

  const exposed: ControlUiMockGateway = {
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
      emitGatewayEvent(MockWebSocket.latest, event, payload);
    },
    findRequests(method, match) {
      // Capture and deferral must select the same RPC scope; child lists share the roster method.
      return requests.filter(
        (request) => (!method || request.method === method) && paramsMatch(request.params, match),
      );
    },
    rejectDeferred(method, error) {
      for (const response of takeDeferredResponses(method)) {
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
      }
    },
    requests,
    resolveDeferred(method, payload) {
      for (const response of takeDeferredResponses(method)) {
        const resolvedPayload = commitFixtureResponse(
          response.method,
          response.params,
          applyScenarioAgentModel(
            response.method,
            payload ?? buildResponse(response.method, response.params),
          ),
        );
        const mockError = isRecord(resolvedPayload) ? resolvedPayload["__mockError"] : undefined;
        response.socket.deliver({
          id: response.id,
          ok: !mockError,
          ...(mockError ? { error: mockError } : { payload: resolvedPayload }),
          type: "res",
        });
        if (!mockError) {
          emitTerminalOutput(response.socket, response.method, response.params, resolvedPayload);
        }
      }
    },
    suspendLatest() {
      MockWebSocket.latest?.suspend();
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
    setGatewayBootId(nextBootId) {
      gatewayBootId = nextBootId;
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
    setRequestHandler(method, handler) {
      requestHandlers.set(method, handler);
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
    setSessionsListResponse(payload) {
      // Generic method responses may be stale or delayed. Only this explicit
      // owner transition advances the canonical rows used by mutation CAS.
      sessions.replaceCanonicalList(payload.sessions);
      hasCanonicalSessionsOverride = true;
      try {
        window.sessionStorage.setItem(
          canonicalSessionsStorageKey,
          JSON.stringify(payload.sessions),
        );
      } catch {
        // The current document still observes the canonical replacement.
      }
      this.setMethodResponse("sessions.list", payload);
    },
    setSessionSharingPolicy(policy) {
      scenario.allowedSessionVisibilities = policy.allowedSessionVisibilities;
      scenario.hasMultipleSessionSharingIdentities = policy.hasMultipleSessionSharingIdentities;
    },
    setHistoryMessages(messages) {
      historyMessagesOverridden = true;
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

  (window as MockGatewayWindow).openclawControlUiE2eGateway = exposed;
  const RoutedWebSocket = function (url: string | URL, protocols?: string | string[]) {
    const resolvedUrl = String(url);
    // Vite's dev client must keep its real socket: the mock would fake the
    // open handshake, and a later setOnline(false) close would make the client
    // believe the dev server restarted and reload the page mid-test.
    const isViteHmr = Array.isArray(protocols)
      ? protocols.includes("vite-hmr")
      : protocols === "vite-hmr";
    if (
      isViteHmr ||
      scenario.webSocketPassthroughPrefixes.some((prefix) => resolvedUrl.startsWith(prefix))
    ) {
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

export async function prepareControlUiMockGatewayScenario(
  scenario: ControlUiMockGatewayScenario = {},
) {
  const { prepareNativeControlUiPluginFixtures } = await import("./control-ui-plugin-fixture.ts");
  const { catalog, assets } = await prepareNativeControlUiPluginFixtures(
    scenario.nativePlugins ?? [],
  );
  const preparedScenario = catalog.plugins.length
    ? {
        ...scenario,
        featureMethods: [
          ...new Set([
            ...(scenario.featureMethods ?? defaultControlUiFeatureMethods),
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ]),
        ],
        methodResponses: {
          ...scenario.methodResponses,
          "plugins.controlUi.list": catalog,
          "plugins.controlUi.report": { ok: true },
        },
      }
    : scenario;
  return { scenario: preparedScenario, assets };
}

export async function installMockGateway(
  page: Page,
  scenario: ControlUiMockGatewayScenario = {},
): Promise<MockGatewayControls> {
  const prepared = await prepareControlUiMockGatewayScenario(scenario);
  if (prepared.assets.size) {
    await page.route(`**${controlUiPluginAssetRoot()}**`, async (route) => {
      const asset = prepared.assets.get(new URL(route.request().url()).pathname);
      await route.fulfill(asset ? { status: 200, ...asset } : { status: 404 });
    });
  }
  const normalizedScenario = normalizeScenario(prepared.scenario);
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
  return createMockGatewayControls(
    page,
    normalizedScenario.sessionKey,
    diagnosticEvents,
    normalizedScenario.methodResponses,
  );
}

function createMockGatewayControls(
  page: Page,
  defaultSessionKey: string,
  diagnosticEvents: ControlUiE2eDiagnosticEvent[],
  methodResponses: Record<string, unknown>,
): MockGatewayControls {
  const emitGatewayEvent = async (event: string, payload?: unknown) => {
    await page.evaluate(
      ({ eventName, eventPayload }) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
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
      const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("Mock Gateway is not installed");
      }
      gateway.deliverLatest(payload);
    }, frame);
  };

  const getRequests = async (method?: string, match?: Record<string, unknown>) =>
    page.evaluate(
      ({ targetMethod, requestMatch }) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        return gateway?.findRequests(targetMethod, requestMatch) ?? [];
      },
      { targetMethod: method, requestMatch: match },
    );

  return {
    async closeLatest(code, reason) {
      await page.evaluate(
        ({ closeCode, closeReason }) => {
          const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
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
          const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
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
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        return gateway?.socketCount() ?? 0;
      });
    },
    async getSocketUrls() {
      return await page.evaluate(() => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        return gateway?.socketUrls() ?? [];
      });
    },
    async rejectDeferred(method, error) {
      await page.evaluate(
        ({ targetMethod, responseError }) => {
          const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
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
          const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
          if (!gateway) {
            throw new Error("Mock Gateway is not installed");
          }
          gateway.resolveDeferred(targetMethod, responsePayload);
        },
        { targetMethod: method, responsePayload: payload },
      );
    },
    async suspendLatest() {
      await page.evaluate(() => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.suspendLatest();
      });
    },
    async setOnline(online) {
      await page.evaluate((nextOnline) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setOnline(nextOnline);
      }, online);
    },
    async setGatewayBootId(bootId) {
      await page.evaluate((nextBootId) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setGatewayBootId(nextBootId);
      }, bootId);
    },
    async setServerBuildId(buildId) {
      await page.evaluate((nextBuildId) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setServerBuildId(nextBuildId);
      }, buildId);
    },
    async setOperatorScopes(scopes) {
      await page.evaluate((nextScopes) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setOperatorScopes(nextScopes);
      }, scopes);
    },
    async setHistoryMessages(messages) {
      await page.evaluate((nextMessages) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setHistoryMessages(nextMessages);
      }, messages);
    },
    async setMethodResponse(method, payload) {
      methodResponses[method] = payload;
      await page.evaluate(
        ({ targetMethod, responsePayload }) => {
          const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
          if (!gateway) {
            throw new Error("Mock Gateway is not installed");
          }
          gateway.setMethodResponse(targetMethod, responsePayload);
        },
        { targetMethod: method, responsePayload: payload },
      );
    },
    async setSessionsListResponse(payload) {
      await page.evaluate((responsePayload) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setSessionsListResponse(responsePayload);
      }, payload);
    },
    async setSessionSharingPolicy(policy) {
      await page.evaluate((nextPolicy) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setSessionSharingPolicy(nextPolicy);
      }, policy);
    },
    async waitForRequest(method, options) {
      const deadline = Date.now() + controlUiE2eWaitTimeoutMs;
      const after = options?.after;
      const match = options?.match;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await page.waitForFunction(
            ({ targetMethod, priorCount, requestMatch }) => {
              const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
              const matching = gateway?.findRequests(targetMethod, requestMatch) ?? [];
              return matching.length > (priorCount ?? 0);
            },
            { targetMethod: method, priorCount: after ?? 0, requestMatch: match },
            // Request capture is non-rendering state. Interval polling avoids background-page
            // requestAnimationFrame throttling when CI runs several headless pages concurrently.
            { polling: 25, timeout: Math.max(1, deadline - Date.now()) },
          );
          const matching = await getRequests(method, match);
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
  const artifactDir = createControlUiE2eArtifactDir(
    "failure",
    configuredDir || path.join(resolveRepoRoot(), ".artifacts", "control-ui-e2e-timeouts", "local"),
  );
  const safeMethod = label.replaceAll(/[^a-zA-Z0-9_.-]+/gu, "-");
  const captureId = `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${safeMethod}`;
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
      shardIndex: process.env.VITEST_SHARD_INDEX ?? null,
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
