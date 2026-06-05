// Runtime web-channel plugin helpers expose web-channel tools through activated plugin runtimes.
import type { AgentToolResult } from "../../agents/runtime/index.js";
import type { ChannelAgentTool } from "../../channels/plugins/types.core.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getDefaultLocalRoots as getDefaultLocalRootsImpl,
  loadWebMedia as loadWebMediaImpl,
  loadWebMediaRaw as loadWebMediaRawImpl,
  optimizeImageToJpeg as optimizeImageToJpegImpl,
} from "../../media/web-media.js";
import type { PollInput } from "../../polls.js";
import {
  createPluginModuleLoaderCache,
  type PluginModuleLoaderCache,
} from "../plugin-module-loader-cache.js";
import type { PluginOrigin } from "../plugin-origin.types.js";
import {
  loadPluginBoundaryModule,
  resolvePluginRuntimeRecordByEntryBaseNames,
  resolvePluginRuntimeModulePath,
} from "./runtime-plugin-boundary.js";

type WebChannelPluginRecord = {
  origin?: PluginOrigin;
  rootDir?: string;
  source: string;
};

type WebChannelConnectionWaitOptions =
  | {
      timeout: "none";
    }
  | {
      timeoutMs: number;
    };

type WebChannelLightRuntimeModule = {
  getActiveWebListener: (accountId?: string | null) => unknown;
  getWebAuthAgeMs: (authDir?: string) => number | null;
  logWebSelfId: (authDir?: string, runtime?: unknown, includeChannelPrefix?: boolean) => void;
  logoutWeb: (params: {
    authDir?: string;
    isLegacyAuthDir?: boolean;
    runtime?: unknown;
  }) => Promise<boolean>;
  readWebSelfId: (authDir?: string) => {
    e164: string | null;
    jid: string | null;
    lid: string | null;
  };
  webAuthExists: (authDir?: string) => Promise<boolean>;
  createWhatsAppLoginTool: () => ChannelAgentTool;
  formatError: (error: unknown) => string;
  getStatusCode: (error: unknown) => number | undefined;
  pickWebChannel: (pref: string, authDir?: string) => Promise<string>;
  resolveDefaultWebAuthDir?: () => string;
  WA_WEB_AUTH_DIR?: string;
};

type WebChannelHeavyRuntimeModule = {
  loginWeb: (
    verbose: boolean,
    waitForConnection?: (sock: unknown) => Promise<void>,
    runtime?: unknown,
    accountId?: string,
  ) => Promise<void>;
  sendMessageWhatsApp: (
    to: string,
    body: string,
    options: {
      verbose: boolean;
      cfg?: OpenClawConfig;
      mediaUrl?: string;
      mediaAccess?: {
        localRoots?: readonly string[];
        readFile?: (filePath: string) => Promise<Buffer>;
      };
      mediaLocalRoots?: readonly string[];
      mediaReadFile?: (filePath: string) => Promise<Buffer>;
      gifPlayback?: boolean;
      accountId?: string;
    },
  ) => Promise<{ messageId: string; toJid: string }>;
  sendPollWhatsApp: (
    to: string,
    poll: PollInput,
    options: { verbose: boolean; accountId?: string; cfg?: OpenClawConfig },
  ) => Promise<{ messageId: string; toJid: string }>;
  sendReactionWhatsApp: (
    chatJid: string,
    messageId: string,
    emoji: string,
    options: {
      verbose: boolean;
      fromMe?: boolean;
      participant?: string;
      accountId?: string;
    },
  ) => Promise<void>;
  createWaSocket: (
    printQr: boolean,
    verbose: boolean,
    opts?: { authDir?: string; onQr?: (qr: string) => void },
  ) => Promise<unknown>;
  handleWhatsAppAction: (
    params: Record<string, unknown>,
    cfg: OpenClawConfig,
  ) => Promise<AgentToolResult<unknown>>;
  monitorWebChannel: (...args: unknown[]) => Promise<unknown>;
  monitorWebInbox: (...args: unknown[]) => Promise<unknown>;
  startWebLoginWithQr: (...args: unknown[]) => Promise<unknown>;
  waitForWaConnection: (sock: unknown, options: WebChannelConnectionWaitOptions) => Promise<void>;
  waitForWebLogin: (...args: unknown[]) => Promise<unknown>;
  extractMediaPlaceholder: (...args: unknown[]) => unknown;
  extractText: (...args: unknown[]) => unknown;
};

type WebChannelRuntimeModuleKind = "heavy" | "light";
type CachedWebChannelRuntimeModule = {
  modulePath: string;
  module: WebChannelHeavyRuntimeModule | WebChannelLightRuntimeModule;
};

const webChannelRuntimeModuleCache = new Map<
  WebChannelRuntimeModuleKind,
  CachedWebChannelRuntimeModule
>();

const moduleLoaders: PluginModuleLoaderCache = createPluginModuleLoaderCache();

/** Resolves the active web-channel plugin record that provides runtime APIs. */
function resolveWebChannelPluginRecord(): WebChannelPluginRecord {
  return resolvePluginRuntimeRecordByEntryBaseNames(["light-runtime-api", "runtime-api"], () => {
    throw new Error(
      "web channel plugin runtime is unavailable: missing plugin that provides light-runtime-api and runtime-api",
    );
  }) as WebChannelPluginRecord;
}

function resolveWebChannelRuntimeModulePath(
  record: WebChannelPluginRecord,
  entryBaseName: "light-runtime-api" | "runtime-api",
): string {
  const modulePath = resolvePluginRuntimeModulePath(record, entryBaseName, () => {
    throw new Error(`web channel plugin runtime is unavailable: missing ${entryBaseName}`);
  });
  if (!modulePath) {
    throw new Error(`web channel plugin runtime is unavailable: missing ${entryBaseName}`);
  }
  return modulePath;
}

function loadCurrentHeavyModuleSync(): WebChannelHeavyRuntimeModule {
  const record = resolveWebChannelPluginRecord();
  const modulePath = resolveWebChannelRuntimeModulePath(record, "runtime-api");
  return loadPluginBoundaryModule<WebChannelHeavyRuntimeModule>(modulePath, moduleLoaders, {
    origin: record.origin,
  });
}

function getCachedWebChannelRuntimeModule<T extends CachedWebChannelRuntimeModule["module"]>(
  kind: WebChannelRuntimeModuleKind,
  modulePath: string,
  load: () => T,
): T {
  const cached = webChannelRuntimeModuleCache.get(kind);
  if (cached?.modulePath === modulePath) {
    return cached.module as T;
  }
  const loaded = load();
  webChannelRuntimeModuleCache.set(kind, { modulePath, module: loaded });
  return loaded;
}

function loadWebChannelLightModule(): WebChannelLightRuntimeModule {
  const record = resolveWebChannelPluginRecord();
  const modulePath = resolveWebChannelRuntimeModulePath(record, "light-runtime-api");
  return getCachedWebChannelRuntimeModule("light", modulePath, () =>
    loadPluginBoundaryModule<WebChannelLightRuntimeModule>(modulePath, moduleLoaders, {
      origin: record.origin,
    }),
  );
}

async function loadWebChannelHeavyModule(): Promise<WebChannelHeavyRuntimeModule> {
  const record = resolveWebChannelPluginRecord();
  const modulePath = resolveWebChannelRuntimeModulePath(record, "runtime-api");
  return getCachedWebChannelRuntimeModule("heavy", modulePath, () =>
    loadPluginBoundaryModule<WebChannelHeavyRuntimeModule>(modulePath, moduleLoaders, {
      origin: record.origin,
    }),
  );
}

function getLightExport<K extends keyof WebChannelLightRuntimeModule>(
  exportName: K,
): NonNullable<WebChannelLightRuntimeModule[K]> {
  const loaded = loadWebChannelLightModule();
  const value = loaded[exportName];
  if (value == null) {
    throw new Error(`web channel plugin runtime is missing export '${exportName}'`);
  }
  return value as NonNullable<WebChannelLightRuntimeModule[K]>;
}

async function getHeavyExport<K extends keyof WebChannelHeavyRuntimeModule>(
  exportName: K,
): Promise<NonNullable<WebChannelHeavyRuntimeModule[K]>> {
  const loaded = await loadWebChannelHeavyModule();
  const value = loaded[exportName];
  if (value == null) {
    throw new Error(`web channel plugin runtime is missing export '${exportName}'`);
  }
  return value as NonNullable<WebChannelHeavyRuntimeModule[K]>;
}

/** Returns the active web channel listener from the light runtime API. */
export function getActiveWebListener(
  ...args: Parameters<WebChannelLightRuntimeModule["getActiveWebListener"]>
): ReturnType<WebChannelLightRuntimeModule["getActiveWebListener"]> {
  return getLightExport("getActiveWebListener")(...args);
}

/** Returns web-auth age from the light runtime API. */
export function getWebAuthAgeMs(
  ...args: Parameters<WebChannelLightRuntimeModule["getWebAuthAgeMs"]>
): ReturnType<WebChannelLightRuntimeModule["getWebAuthAgeMs"]> {
  return getLightExport("getWebAuthAgeMs")(...args);
}

/** Logs the active web account self id through the light runtime API. */
export function logWebSelfId(
  ...args: Parameters<WebChannelLightRuntimeModule["logWebSelfId"]>
): ReturnType<WebChannelLightRuntimeModule["logWebSelfId"]> {
  return getLightExport("logWebSelfId")(...args);
}

/** Starts web-channel login through the heavy runtime API. */
export function loginWeb(
  ...args: Parameters<WebChannelHeavyRuntimeModule["loginWeb"]>
): ReturnType<WebChannelHeavyRuntimeModule["loginWeb"]> {
  return loadWebChannelHeavyModule().then((loaded) => loaded.loginWeb(...args));
}

/** Logs out the web-channel account through the light runtime API. */
export function logoutWeb(
  ...args: Parameters<WebChannelLightRuntimeModule["logoutWeb"]>
): ReturnType<WebChannelLightRuntimeModule["logoutWeb"]> {
  return getLightExport("logoutWeb")(...args);
}

/** Reads the web-channel self id through the light runtime API. */
export function readWebSelfId(
  ...args: Parameters<WebChannelLightRuntimeModule["readWebSelfId"]>
): ReturnType<WebChannelLightRuntimeModule["readWebSelfId"]> {
  return getLightExport("readWebSelfId")(...args);
}

/** Checks whether web-channel auth exists through the light runtime API. */
export function webAuthExists(
  ...args: Parameters<WebChannelLightRuntimeModule["webAuthExists"]>
): ReturnType<WebChannelLightRuntimeModule["webAuthExists"]> {
  return getLightExport("webAuthExists")(...args);
}

/** Sends a web-channel message through the heavy runtime API. */
export function sendWebChannelMessage(
  ...args: Parameters<WebChannelHeavyRuntimeModule["sendMessageWhatsApp"]>
): ReturnType<WebChannelHeavyRuntimeModule["sendMessageWhatsApp"]> {
  return loadWebChannelHeavyModule().then((loaded) => loaded.sendMessageWhatsApp(...args));
}

/** Sends a web-channel poll through the heavy runtime API. */
export function sendWebChannelPoll(
  ...args: Parameters<WebChannelHeavyRuntimeModule["sendPollWhatsApp"]>
): ReturnType<WebChannelHeavyRuntimeModule["sendPollWhatsApp"]> {
  return loadWebChannelHeavyModule().then((loaded) => loaded.sendPollWhatsApp(...args));
}

/** Sends a web-channel reaction through the heavy runtime API. */
export function sendWebChannelReaction(
  ...args: Parameters<WebChannelHeavyRuntimeModule["sendReactionWhatsApp"]>
): ReturnType<WebChannelHeavyRuntimeModule["sendReactionWhatsApp"]> {
  return loadWebChannelHeavyModule().then((loaded) => loaded.sendReactionWhatsApp(...args));
}

/** Creates the web-channel login tool from the light runtime API. */
export function createRuntimeWebChannelLoginTool(
  ...args: Parameters<WebChannelLightRuntimeModule["createWhatsAppLoginTool"]>
): ReturnType<WebChannelLightRuntimeModule["createWhatsAppLoginTool"]> {
  return getLightExport("createWhatsAppLoginTool")(...args);
}

/** Creates a web-channel socket through the heavy runtime API. */
export function createWebChannelSocket(
  ...args: Parameters<WebChannelHeavyRuntimeModule["createWaSocket"]>
): ReturnType<WebChannelHeavyRuntimeModule["createWaSocket"]> {
  return loadWebChannelHeavyModule().then((loaded) => loaded.createWaSocket(...args));
}

/** Formats a web-channel runtime error through the light runtime API. */
export function formatError(
  ...args: Parameters<WebChannelLightRuntimeModule["formatError"]>
): ReturnType<WebChannelLightRuntimeModule["formatError"]> {
  return getLightExport("formatError")(...args);
}

/** Reads a web-channel status code from the light runtime API. */
export function getStatusCode(
  ...args: Parameters<WebChannelLightRuntimeModule["getStatusCode"]>
): ReturnType<WebChannelLightRuntimeModule["getStatusCode"]> {
  return getLightExport("getStatusCode")(...args);
}

/** Picks the active web channel through the light runtime API. */
export function pickWebChannel(
  ...args: Parameters<WebChannelLightRuntimeModule["pickWebChannel"]>
): ReturnType<WebChannelLightRuntimeModule["pickWebChannel"]> {
  return getLightExport("pickWebChannel")(...args);
}

/** Resolves the default web-channel auth directory from the light runtime API. */
export function resolveWebChannelAuthDir(): ReturnType<
  NonNullable<WebChannelLightRuntimeModule["resolveDefaultWebAuthDir"]>
> {
  const loaded = loadWebChannelLightModule();
  if (loaded.resolveDefaultWebAuthDir) {
    return loaded.resolveDefaultWebAuthDir();
  }
  // Older light runtimes expose the default auth dir as a primitive string.
  // Do not accept string-like objects here; Node path APIs reject them before
  // coercion.
  if (typeof loaded.WA_WEB_AUTH_DIR === "string") {
    return loaded.WA_WEB_AUTH_DIR;
  }
  throw new Error("web channel plugin runtime is missing export 'resolveDefaultWebAuthDir'");
}

/** Handles a web-channel action through the heavy runtime API. */
export async function handleWebChannelAction(
  ...args: Parameters<WebChannelHeavyRuntimeModule["handleWhatsAppAction"]>
): ReturnType<WebChannelHeavyRuntimeModule["handleWhatsAppAction"]> {
  return (await getHeavyExport("handleWhatsAppAction"))(...args);
}

/** Loads web media through the core media helper. */
export async function loadWebMedia(
  ...args: Parameters<typeof loadWebMediaImpl>
): ReturnType<typeof loadWebMediaImpl> {
  return await loadWebMediaImpl(...args);
}

/** Loads raw web media through the core media helper. */
export async function loadWebMediaRaw(
  ...args: Parameters<typeof loadWebMediaRawImpl>
): ReturnType<typeof loadWebMediaRawImpl> {
  return await loadWebMediaRawImpl(...args);
}

/** Starts web-channel monitoring through the heavy runtime API. */
export function monitorWebChannel(
  ...args: Parameters<WebChannelHeavyRuntimeModule["monitorWebChannel"]>
): ReturnType<WebChannelHeavyRuntimeModule["monitorWebChannel"]> {
  return loadWebChannelHeavyModule().then((loaded) => loaded.monitorWebChannel(...args));
}

/** Starts web inbox monitoring through the heavy runtime API. */
export async function monitorWebInbox(
  ...args: Parameters<WebChannelHeavyRuntimeModule["monitorWebInbox"]>
): ReturnType<WebChannelHeavyRuntimeModule["monitorWebInbox"]> {
  return (await getHeavyExport("monitorWebInbox"))(...args);
}

/** Optimizes an image to JPEG through the core media helper. */
export async function optimizeImageToJpeg(
  ...args: Parameters<typeof optimizeImageToJpegImpl>
): ReturnType<typeof optimizeImageToJpegImpl> {
  return await optimizeImageToJpegImpl(...args);
}

/** Starts QR login through the heavy runtime API. */
export async function startWebLoginWithQr(
  ...args: Parameters<WebChannelHeavyRuntimeModule["startWebLoginWithQr"]>
): ReturnType<WebChannelHeavyRuntimeModule["startWebLoginWithQr"]> {
  return (await getHeavyExport("startWebLoginWithQr"))(...args);
}

/** Waits for web-channel socket connection through the heavy runtime API. */
export async function waitForWebChannelConnection(
  ...args: Parameters<WebChannelHeavyRuntimeModule["waitForWaConnection"]>
): ReturnType<WebChannelHeavyRuntimeModule["waitForWaConnection"]> {
  return (await getHeavyExport("waitForWaConnection"))(...args);
}

/** Waits for web-channel login through the heavy runtime API. */
export async function waitForWebLogin(
  ...args: Parameters<WebChannelHeavyRuntimeModule["waitForWebLogin"]>
): ReturnType<WebChannelHeavyRuntimeModule["waitForWebLogin"]> {
  return (await getHeavyExport("waitForWebLogin"))(...args);
}

/** Extracts media placeholders through the heavy runtime API. */
export const extractMediaPlaceholder = (
  ...args: Parameters<WebChannelHeavyRuntimeModule["extractMediaPlaceholder"]>
) => loadCurrentHeavyModuleSync().extractMediaPlaceholder(...args);

/** Extracts text through the heavy runtime API. */
export const extractText = (...args: Parameters<WebChannelHeavyRuntimeModule["extractText"]>) =>
  loadCurrentHeavyModuleSync().extractText(...args);

/** Returns default local media roots through the core media helper. */
export function getDefaultLocalRoots(
  ...args: Parameters<typeof getDefaultLocalRootsImpl>
): ReturnType<typeof getDefaultLocalRootsImpl> {
  return getDefaultLocalRootsImpl(...args);
}
