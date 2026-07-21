// Control UI test helper supports control ui e2e setup.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import type { ViteDevServer } from "vite";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-contract.js";
import {
  controlUiBrowserOnlySharedModuleAliases,
  resolveExternalPackageAliasesForVite,
  resolveSourcePackageAliasesForVite,
  resolveTsconfigPathAliasesForVite,
} from "../../vite.config.ts";
import type { ControlUiBuildInfo } from "../build-info.ts";

const require = createRequire(import.meta.url);
const json5EsmPath = require.resolve("json5/dist/index.mjs");
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

export type MockGatewayRequest = {
  id: string;
  method: string;
  params?: unknown;
};

export type ControlUiMockGatewayScenario = {
  assistantAgentId?: string;
  assistantName?: string;
  basePath?: string;
  controlUiTabs?: Array<{
    group?: string;
    icon?: string;
    id: string;
    label: string;
    pluginId: string;
  }>;
  featureCapabilities?: string[];
  defaultAgentId?: string;
  deferredMethods?: string[];
  /** Non-release gateway checkout branch surfaced in the sidebar footer. */
  devGitBranch?: string;
  deviceToken?: string;
  featureMethods?: string[];
  historyMessages?: unknown[];
  /** Static payloads, parameter-matched cases, or call-ordered sequences. */
  methodResponses?: Record<string, unknown>;
  /** Replayed in-flight run snapshot served by chat.history and chat.startup. */
  inFlightRun?: { runId: string; text?: string; plan?: unknown } | null;
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
    events: Array<{ event: "agent" | "session.tool"; payload: unknown }>;
    intervalMs?: number;
  };
  /** Session run state served alongside history (hasActiveRun/activeRunIds). */
  sessionInfo?: Record<string, unknown> | null;
  /** Partition sessions.list fixtures by archived state after applying patches. */
  sessionArchiveFiltering?: boolean;
  models?: Array<{
    id: string;
    name: string;
    provider: string;
    available?: boolean;
  }>;
  sessionKey?: string;
  /** Initial gateway-owned custom group catalog (sessions.groups.*), in order. */
  sessionGroups?: string[];
  terminalEnabled?: boolean;
  workspace?: string;
  workspaceGit?: boolean;
};

type NormalizedControlUiMockGatewayScenario = Required<ControlUiMockGatewayScenario>;

export type ControlUiE2eServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

export type MockGatewayControls = {
  closeLatest: (code?: number, reason?: string) => Promise<void>;
  deliverLatest: (frame: unknown) => Promise<void>;
  deferNext: (method: string) => Promise<void>;
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
  setHistoryMessages: (messages: unknown[]) => Promise<void>;
  setMethodResponse: (method: string, payload: unknown) => Promise<void>;
  waitForRequest: (method: string) => Promise<MockGatewayRequest>;
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

export async function startControlUiE2eServer(
  buildInfo: ControlUiBuildInfo = {
    version: "2026.7.10",
    commit: "0123456789abcdef0123456789abcdef01234567",
    commitAt: "2026-07-10T11:22:33.000Z",
    builtAt: "2026-07-10T12:34:56.000Z",
    branch: null,
    dirty: false,
    buildId: "e2e",
  },
): Promise<ControlUiE2eServer> {
  const { createServer } = await import("vite");
  const repoRoot = resolveRepoRoot();
  const uiRoot = path.join(repoRoot, "ui");
  const port = await resolveAvailableLoopbackPort();
  const server = await createServer({
    base: "/",
    cacheDir: path.join(repoRoot, ".artifacts", "control-ui-e2e-vite"),
    clearScreen: false,
    configFile: false,
    define: {
      "globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO": JSON.stringify(buildInfo),
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
    plugins: [controlUiBrowserOnlySharedModuleAliases()],
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

function resolveServerBaseUrl(server: ViteDevServer): string {
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
    assistantAgentId: scenario.assistantAgentId?.trim() || defaultAgentId,
    assistantName: scenario.assistantName?.trim() || "OpenClaw",
    basePath,
    controlUiTabs: scenario.controlUiTabs ?? [],
    featureCapabilities: scenario.featureCapabilities ?? [],
    defaultAgentId,
    deferredMethods: scenario.deferredMethods ?? [],
    devGitBranch: scenario.devGitBranch?.trim() || "",
    deviceToken: scenario.deviceToken?.trim() || "e2e-device-token",
    featureMethods: scenario.featureMethods ?? ["chat.metadata", "chat.startup"],
    historyMessages: scenario.historyMessages ?? [],
    methodResponses: scenario.methodResponses ?? {},
    inFlightRun: scenario.inFlightRun ?? null,
    presenceUsers: scenario.presenceUsers ?? [],
    models: scenario.models ?? [{ id: "gpt-5.5", name: "gpt-5.5", provider: "openai" }],
    repeatingSessionEvents: scenario.repeatingSessionEvents ?? { events: [] },
    sessionInfo: scenario.sessionInfo ?? null,
    sessionArchiveFiltering: scenario.sessionArchiveFiltering ?? false,
    sessionKey,
    sessionGroups: scenario.sessionGroups ?? [],
    terminalEnabled: scenario.terminalEnabled ?? false,
    workspace: scenario.workspace ?? "",
    workspaceGit: scenario.workspaceGit ?? false,
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
    localMediaPreviewRoots: [],
    serverVersion: "e2e",
    terminalEnabled: normalizedScenario.terminalEnabled,
  };
}

export function createControlUiMockGatewayInitScript(
  scenario: ControlUiMockGatewayScenario = {},
): string {
  const input = {
    protocolVersion: PROTOCOL_VERSION,
    scenario: normalizeScenario(scenario),
  };
  return `(() => { const __name = (target) => target; (${installControlUiMockGateway.toString()})(${JSON.stringify(input)}); })();`;
}

function installControlUiMockGateway(input: {
  protocolVersion: number;
  scenario: NormalizedControlUiMockGatewayScenario;
}) {
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
  type ExposedGateway = {
    closeLatest: (code?: number, reason?: string) => void;
    deliverLatest: (frame: unknown) => void;
    deferNext: (method: string) => void;
    emit: (event: string, payload?: unknown) => void;
    findRequests: (method?: string) => BrowserRequest[];
    rejectDeferred: (
      method: string,
      error?: { code?: string; message?: string; details?: unknown; retryable?: boolean },
    ) => void;
    requests: BrowserRequest[];
    resolveDeferred: (method: string, payload?: unknown) => void;
    setOnline: (online: boolean) => void;
    setHistoryMessages: (messages: unknown[]) => void;
    setMethodResponse: (method: string, payload: unknown) => void;
    socketCount: () => number;
    socketUrls: () => string[];
  };
  type WindowWithGateway = Window & {
    __OPENCLAW_CONTROL_UI_BASE_PATH__?: string;
    openclawControlUiE2eGateway?: ExposedGateway;
  };

  const scenario: BrowserScenario = input.scenario;
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
  const deferredMethods: string[] = [...scenario.deferredMethods];
  const deferredResponses: DeferredResponse[] = [];
  const requests: BrowserRequest[] = [];
  const methodResponseSequenceIndexes = new Map<string, number>();
  const sessionPatches = new Map<string, Record<string, unknown>>();
  const sessionMessageSubscriptions = new Set<string>();
  const sockets: Array<{ readonly url: string }> = [];
  let sessionMessageEventIndex = 0;
  let sessionMessageEventTimer: number | null = null;
  const offlineStateKey = "openclaw.control-ui-e2e.gatewayOffline";
  // Gateway-owned custom group catalog (sessions.groups.*). Persisted in
  // sessionStorage so a page reload keeps the catalog the way the real
  // gateway's SQLite store does; renames replay onto static sessions.list
  // fixtures because the real gateway rewrites member categories server-side.
  const groupsStateKey = "openclaw.control-ui-e2e.sessionGroups";
  let groupsState: { names: string[]; renames: Array<{ from: string; to: string | null }> } = {
    names: [...input.scenario.sessionGroups],
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

  function groupsPayload(): { groups: Array<{ name: string; position: number }> } {
    return { groups: groupsState.names.map((name, position) => ({ name, position })) };
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
    for (const key of ["model", "thinkingLevel", "fastMode", "category", "pinned"] as const) {
      if (hasOwn(params, key)) {
        patch[key] = params[key];
      }
    }
    if (scenario.sessionArchiveFiltering && hasOwn(params, "archived")) {
      patch.archived = params.archived;
    }
    sessionPatches.set(params.key, patch);
  }

  function applySessionPatches(response: unknown, params: unknown): unknown {
    if (!isRecord(response) || !Array.isArray(response.sessions)) {
      return response;
    }
    const showArchived = isRecord(params) && params.archived === true;
    const sessions = response.sessions.map((row) => {
      if (!isRecord(row) || typeof row.key !== "string") {
        return row;
      }
      const patch = sessionPatches.get(row.key);
      const next = patch ? { ...row, ...patch } : { ...row };
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
      return { ...response, sessions };
    }
    const filteredSessions = sessions.filter(
      (row) => isRecord(row) && (row.archived === true) === showArchived,
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
          parsedConfig = JSON.parse(configState.raw) as unknown;
        } catch {
          // JSON5-only raw keeps the last parseable config object.
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
        // Like the real gateway, ack with the persisted snapshot hash.
        return { ok: true, hash: mockConfigHash() };
      }
    }
    const configured = configuredResponse(method, params);
    if (configured.found) {
      return method === "sessions.list"
        ? applySessionPatches(configured.value, params)
        : configured.value;
    }
    switch (method) {
      case "connect":
        return {
          auth: {
            deviceToken: scenario.deviceToken,
            role: "operator",
            scopes: [
              "operator.admin",
              "operator.read",
              "operator.write",
              "operator.approvals",
              "operator.pairing",
            ],
          },
          features: {
            capabilities: scenario.featureCapabilities,
            events: [],
            methods: scenario.featureMethods,
          },
          controlUiTabs: scenario.controlUiTabs,
          protocol: protocolVersion,
          server: { connId: "control-ui-e2e", version: "e2e" },
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
      case "sessions.groups.list":
        return groupsPayload();
      case "sessions.groups.put": {
        groupsState.names = normalizedGroupNames(isRecord(params) ? params.names : undefined);
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
          groupsState.renames.push({ from, to });
          persistGroupsState();
        }
        return { ok: true, updatedSessions: 0, ...groupsPayload() };
      }
      case "sessions.groups.delete": {
        const name = isRecord(params) && typeof params.name === "string" ? params.name.trim() : "";
        if (name) {
          groupsState.names = groupsState.names.filter((existing) => existing !== name);
          groupsState.renames.push({ from: name, to: null });
          persistGroupsState();
        }
        return { ok: true, updatedSessions: 0, ...groupsPayload() };
      }
      case "sessions.subscribe":
        return { ok: true };
      case "sessions.messages.subscribe":
        return {
          key: isRecord(params) && typeof params.key === "string" ? params.key : "",
        };
      case "sessions.messages.unsubscribe":
        return { ok: true };
      default:
        return {};
    }
  }

  function shouldDefer(method: string): boolean {
    const index = deferredMethods.indexOf(method);
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
        payload: { nonce: "control-ui-e2e-nonce" },
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
      if (shouldDefer(method)) {
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
    deferNext(method) {
      deferredMethods.push(method);
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
      response.socket.deliver({
        id: response.id,
        ok: true,
        payload: payload ?? buildResponse(response.method, response.params),
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
        MockWebSocket.latest?.close(1006, "mock offline");
        return;
      }
      MockWebSocket.latest?.openConnection();
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
    socketUrls() {
      return sockets.map((socket) => socket.url);
    },
  };

  (window as unknown as WindowWithGateway).openclawControlUiE2eGateway = exposed;
  window.WebSocket = MockWebSocket as unknown as typeof WebSocket;
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
  await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
    route.fulfill({
      body: JSON.stringify(createControlUiMockBootstrapConfig(normalizedScenario)),
      contentType: "application/json",
      status: 200,
    }),
  );
  await page.addInitScript({ content: createControlUiMockGatewayInitScript(normalizedScenario) });
  return createMockGatewayControls(page, normalizedScenario.sessionKey);
}

function createMockGatewayControls(page: Page, defaultSessionKey: string): MockGatewayControls {
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
    async deferNext(method) {
      await page.evaluate((targetMethod) => {
        const gateway = (
          window as Window & {
            openclawControlUiE2eGateway?: {
              deferNext: (method: string) => void;
            };
          }
        ).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.deferNext(targetMethod);
      }, method);
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
    async waitForRequest(method) {
      await page.waitForFunction(
        (targetMethod) => {
          const gateway = (
            window as Window & {
              openclawControlUiE2eGateway?: {
                requests: MockGatewayRequest[];
              };
            }
          ).openclawControlUiE2eGateway;
          return Boolean(gateway?.requests.some((request) => request.method === targetMethod));
        },
        method,
        { timeout: 10_000 },
      );
      const requests = await getRequests(method);
      const request = requests.at(-1);
      if (!request) {
        throw new Error(`No mock Gateway request found for ${method}`);
      }
      return request;
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
