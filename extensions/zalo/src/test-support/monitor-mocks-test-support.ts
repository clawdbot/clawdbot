import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import {
  createEmptyPluginRegistry,
  createRuntimeEnv,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedZaloAccount } from "../types.js";

type MonitorModule = typeof import("../monitor.js");
type SecretInputModule = typeof import("../secret-input.js");
type WebhookModule = typeof import("../monitor.webhook.js");

const monitorModuleUrl = new URL("../monitor.ts", import.meta.url).href;
const secretInputModuleUrl = new URL("../secret-input.ts", import.meta.url).href;
const webhookModuleUrl = new URL("../monitor.webhook.ts", import.meta.url).href;
const apiModuleId = new URL("../api.js", import.meta.url).pathname;
const runtimeModuleId = new URL("../runtime.js", import.meta.url).pathname;

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
const loadedMonitorModules = new Set<MonitorModule>();
const cachedMonitorModules = new Map<string, Promise<MonitorModule>>();
let cachedWebhookModule: Promise<WebhookModule> | undefined;

type ZaloLifecycleMocks = {
  setWebhookMock: AsyncUnknownMock;
  deleteWebhookMock: AsyncUnknownMock;
  getWebhookInfoMock: AsyncUnknownMock;
  getUpdatesMock: UnknownMock;
  sendChatActionMock: AsyncUnknownMock;
  sendMessageMock: AsyncUnknownMock;
  sendPhotoMock: AsyncUnknownMock;
  getZaloRuntimeMock: UnknownMock;
};

const lifecycleMocks = vi.hoisted(
  (): ZaloLifecycleMocks => ({
    setWebhookMock: vi.fn(async () => ({ ok: true, result: { url: "" } })),
    deleteWebhookMock: vi.fn(async () => ({ ok: true, result: { url: "" } })),
    getWebhookInfoMock: vi.fn(async () => ({ ok: true, result: { url: "" } })),
    getUpdatesMock: vi.fn(() => new Promise(() => {})),
    sendChatActionMock: vi.fn(async () => ({ ok: true })),
    sendMessageMock: vi.fn(async () => ({
      ok: true,
      result: { message_id: "zalo-test-reply-1" },
    })),
    sendPhotoMock: vi.fn(async () => ({ ok: true })),
    getZaloRuntimeMock: vi.fn(),
  }),
);

const setWebhookMock = lifecycleMocks.setWebhookMock;
export const getUpdatesMock = lifecycleMocks.getUpdatesMock;
export const sendMessageMock = lifecycleMocks.sendMessageMock;
export const sendPhotoMock = lifecycleMocks.sendPhotoMock;
export const getZaloRuntimeMock: UnknownMock = lifecycleMocks.getZaloRuntimeMock;

function installLifecycleModuleMocks() {
  vi.doMock(apiModuleId, async () => {
    const actual = await vi.importActual<object>(apiModuleId);
    return {
      ...actual,
      deleteWebhook: lifecycleMocks.deleteWebhookMock,
      getUpdates: lifecycleMocks.getUpdatesMock,
      getWebhookInfo: lifecycleMocks.getWebhookInfoMock,
      sendChatAction: lifecycleMocks.sendChatActionMock,
      sendMessage: lifecycleMocks.sendMessageMock,
      sendPhoto: lifecycleMocks.sendPhotoMock,
      setWebhook: lifecycleMocks.setWebhookMock,
    };
  });

  vi.doMock(runtimeModuleId, () => ({
    getZaloRuntime: lifecycleMocks.getZaloRuntimeMock,
  }));
}

async function importMonitorModule(params: {
  cacheBust: string;
  mocked: boolean;
}): Promise<MonitorModule> {
  vi.resetModules();
  if (params.mocked) {
    installLifecycleModuleMocks();
  } else {
    vi.doUnmock(apiModuleId);
    vi.doUnmock(runtimeModuleId);
  }
  const module = (await import(
    `${monitorModuleUrl}?t=${params.cacheBust}-${Date.now()}`
  )) as MonitorModule;
  loadedMonitorModules.add(module);
  return module;
}

async function importSecretInputModule(cacheBust: string): Promise<SecretInputModule> {
  return (await import(
    `${secretInputModuleUrl}?t=${cacheBust}-${Date.now()}`
  )) as SecretInputModule;
}

async function importCachedWebhookModule(): Promise<WebhookModule> {
  cachedWebhookModule ??= import(webhookModuleUrl) as Promise<WebhookModule>;
  return await cachedWebhookModule;
}

export async function resetLifecycleTestState() {
  vi.clearAllMocks();
  (await importCachedWebhookModule()).clearZaloWebhookSecurityStateForTest();
  for (const module of loadedMonitorModules) {
    module.__testing.clearHostedMediaRouteRefsForTest();
  }
  setActivePluginRegistry(createEmptyPluginRegistry());
}

export function setLifecycleRuntimeCore(
  channel: NonNullable<NonNullable<Parameters<typeof createPluginRuntimeMock>[0]>["channel"]>,
) {
  getZaloRuntimeMock.mockReturnValue(
    createPluginRuntimeMock({
      channel,
    }),
  );
}

async function loadLifecycleMonitorModule(): Promise<MonitorModule> {
  return await importMonitorModule({ cacheBust: "monitor", mocked: true });
}

export async function loadCachedLifecycleMonitorModule(cacheKey: string): Promise<MonitorModule> {
  const key = cacheKey.trim();
  if (!key) {
    throw new Error("cacheKey is required");
  }
  const cached =
    cachedMonitorModules.get(key) ??
    (async () => {
      installLifecycleModuleMocks();
      const module = (await import(`${monitorModuleUrl}?t=${key}`)) as MonitorModule;
      loadedMonitorModules.add(module);
      return module;
    })();
  cachedMonitorModules.set(key, cached);
  return await cached;
}

export async function startWebhookLifecycleMonitor(params: {
  account: ResolvedZaloAccount;
  config: OpenClawConfig;
  token?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  cacheKey?: string;
}) {
  const registry = createEmptyPluginRegistry();
  setActivePluginRegistry(registry);
  const abort = new AbortController();
  const runtime = createRuntimeEnv();
  const accountWebhookUrl =
    typeof params.account.config?.webhookUrl === "string"
      ? params.account.config.webhookUrl
      : undefined;
  const webhookUrl = params.webhookUrl ?? accountWebhookUrl;
  const { normalizeSecretInputString } = await importSecretInputModule("secret-input");
  const webhookSecret =
    params.webhookSecret ?? normalizeSecretInputString(params.account.config?.webhookSecret);
  const { monitorZaloProvider } = params.cacheKey
    ? await loadCachedLifecycleMonitorModule(params.cacheKey)
    : await loadLifecycleMonitorModule();
  const run = monitorZaloProvider({
    token: params.token ?? "zalo-token",
    account: params.account,
    config: params.config,
    runtime,
    abortSignal: abort.signal,
    useWebhook: true,
    webhookUrl,
    webhookSecret,
  });

  await vi.waitFor(() => {
    const webhookRoute = registry.httpRoutes.find((route) => route.source === "zalo-webhook");
    const hostedMediaRoute = registry.httpRoutes.find(
      (route) => route.source === "zalo-hosted-media",
    );
    if (setWebhookMock.mock.calls.length !== 1 || !webhookRoute || !hostedMediaRoute) {
      throw new Error("waiting for webhook registration");
    }
  });

  const route = registry.httpRoutes.find((entry) => entry.source === "zalo-webhook");
  if (!route) {
    throw new Error("missing plugin HTTP route");
  }

  return {
    abort,
    registry,
    route,
    run,
    runtime,
    stop: async () => {
      abort.abort();
      await run;
    },
  };
}
