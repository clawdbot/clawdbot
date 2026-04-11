import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { createJiti } from "jiti";
import type { ChannelAgentTool } from "../../channels/plugins/types.core.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  getDefaultLocalRoots as getDefaultLocalRootsImpl,
  loadWebMedia as loadWebMediaImpl,
  loadWebMediaRaw as loadWebMediaRawImpl,
  optimizeImageToJpeg as optimizeImageToJpegImpl,
} from "../../media/web-media.js";
import type { PollInput } from "../../polls.js";
import {
  loadPluginBoundaryModuleWithJiti,
  resolvePluginRuntimeRecordByEntryBaseNames,
  resolvePluginRuntimeModulePath,
} from "./runtime-plugin-boundary.js";

type WebChannelPluginRecord = {
  origin?: string;
  rootDir?: string;
  source: string;
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
  WA_WEB_AUTH_DIR: string;
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
  runWebHeartbeatOnce: (...args: unknown[]) => Promise<unknown>;
  startWebLoginWithQr: (...args: unknown[]) => Promise<unknown>;
  waitForWaConnection: (sock: unknown) => Promise<void>;
  waitForWebLogin: (...args: unknown[]) => Promise<unknown>;
  extractMediaPlaceholder: (...args: unknown[]) => unknown;
  extractText: (...args: unknown[]) => unknown;
  resolveHeartbeatRecipients: (...args: unknown[]) => unknown;
};

let cachedHeavyModulePath: string | null = null;
let cachedHeavyModule: WebChannelHeavyRuntimeModule | null = null;
let cachedLightModulePath: string | null = null;
let cachedLightModule: WebChannelLightRuntimeModule | null = null;

const jitiLoaders = new Map<boolean, ReturnType<typeof createJiti>>();

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
  const modulePath = resolveWebChannelRuntimeModulePath(
    resolveWebChannelPluginRecord(),
    "runtime-api",
  );
  return loadPluginBoundaryModuleWithJiti<WebChannelHeavyRuntimeModule>(modulePath, jitiLoaders);
}

function loadWebChannelLightModule(): WebChannelLightRuntimeModule {
  const modulePath = resolveWebChannelRuntimeModulePath(
    resolveWebChannelPluginRecord(),
    "light-runtime-api",
  );
  if (cachedLightModule && cachedLightModulePath === modulePath) {
    return cachedLightModule;
  }
  const loaded = loadPluginBoundaryModuleWithJiti<WebChannelLightRuntimeModule>(
    modulePath,
    jitiLoaders,
  );
  cachedLightModulePath = modulePath;
  cachedLightModule = loaded;
  return loaded;
}

async function loadWebChannelHeavyModule(): Promise<WebChannelHeavyRuntimeModule> {
  const record = resolveWebChannelPluginRecord();
  const modulePath = resolveWebChannelRuntimeModulePath(record, "runtime-api");
  if (cachedHeavyModule && cachedHeavyModulePath === modulePath) {
    return cachedHeavyModule;
  }
  const loaded = loadPluginBoundaryModuleWithJiti<WebChannelHeavyRuntimeModule>(
    modulePath,
    jitiLoaders,
  );
  cachedHeavyModulePath = modulePath;
  cachedHeavyModule = loaded;
  return loaded;
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

export function getActiveWebListener(
  ...args: Parameters<WebChannelLightRuntimeModule["getActiveWebListener"]>
): ReturnType<WebChannelLightRuntimeModule["getActiveWebListener"]> {
  return getLightExport("getActiveWebListener")(...args);
}

export function getWebAuthAgeMs(
  ...args: Parameters<WebChannelLightRuntimeModule["getWebAuthAgeMs"]>
): ReturnType<WebChannelLightRuntimeModule["getWebAuthAgeMs"]> {
  return getLightExport("getWebAuthAgeMs")(...args);
}

export function logWebSelfId(
  ...args: Parameters<WebChannelLightRuntimeModule["logWebSelfId"]>
): ReturnType<WebChannelLightRuntimeModule["logWebSelfId"]> {
  return getLightExport("logWebSelfId")(...args);
}

export function loginWeb(
  ...args: Parameters<WebChannelHeavyRuntimeModule["loginWeb"]>
): ReturnType<WebChannelHeavyRuntimeModule["loginWeb"]> {
  return loadWebChannelHeavyModule().then((loaded) => loaded.loginWeb(...args));
}

export function logoutWeb(
  ...args: Parameters<WebChannelLightRuntimeModule["logoutWeb"]>
): ReturnType<WebChannelLightRuntimeModule["logoutWeb"]> {
  return getLightExport("logoutWeb")(...args);
}

export function readWebSelfId(
  ...args: Parameters<WebChannelLightRuntimeModule["readWebSelfId"]>
): ReturnType<WebChannelLightRuntimeModule["readWebSelfId"]> {
  return getLightExport("readWebSelfId")(...args);
}

export function webAuthExists(
  ...args: Parameters<WebChannelLightRuntimeModule["webAuthExists"]>
): ReturnType<WebChannelLightRuntimeModule["webAuthExists"]> {
  return getLightExport("webAuthExists")(...args);
}

export function sendWebChannelMessage(
  ...args: Parameters<WebChannelHeavyRuntimeModule["sendMessageWhatsApp"]>
): ReturnType<WebChannelHeavyRuntimeModule["sendMessageWhatsApp"]> {
  return loadWebChannelHeavyModule().then((loaded) => loaded.sendMessageWhatsApp(...args));
}

export function sendWebChannelPoll(
  ...args: Parameters<WebChannelHeavyRuntimeModule["sendPollWhatsApp"]>
): ReturnType<WebChannelHeavyRuntimeModule["sendPollWhatsApp"]> {
  return loadWebChannelHeavyModule().then((loaded) => loaded.sendPollWhatsApp(...args));
}

export function sendWebChannelReaction(
  ...args: Parameters<WebChannelHeavyRuntimeModule["sendReactionWhatsApp"]>
): ReturnType<WebChannelHeavyRuntimeModule["sendReactionWhatsApp"]> {
  return loadWebChannelHeavyModule().then((loaded) => loaded.sendReactionWhatsApp(...args));
}

export function createRuntimeWebChannelLoginTool(
  ...args: Parameters<WebChannelLightRuntimeModule["createWhatsAppLoginTool"]>
): ReturnType<WebChannelLightRuntimeModule["createWhatsAppLoginTool"]> {
  return getLightExport("createWhatsAppLoginTool")(...args);
}

export function createWebChannelSocket(
  ...args: Parameters<WebChannelHeavyRuntimeModule["createWaSocket"]>
): ReturnType<WebChannelHeavyRuntimeModule["createWaSocket"]> {
  return loadWebChannelHeavyModule().then((loaded) => loaded.createWaSocket(...args));
}

export function formatError(
  ...args: Parameters<WebChannelLightRuntimeModule["formatError"]>
): ReturnType<WebChannelLightRuntimeModule["formatError"]> {
  return getLightExport("formatError")(...args);
}

export function getStatusCode(
  ...args: Parameters<WebChannelLightRuntimeModule["getStatusCode"]>
): ReturnType<WebChannelLightRuntimeModule["getStatusCode"]> {
  return getLightExport("getStatusCode")(...args);
}

export function pickWebChannel(
  ...args: Parameters<WebChannelLightRuntimeModule["pickWebChannel"]>
): ReturnType<WebChannelLightRuntimeModule["pickWebChannel"]> {
  return getLightExport("pickWebChannel")(...args);
}

export function resolveWebChannelAuthDir(): WebChannelLightRuntimeModule["WA_WEB_AUTH_DIR"] {
  return getLightExport("WA_WEB_AUTH_DIR");
}

export async function handleWebChannelAction(
  ...args: Parameters<WebChannelHeavyRuntimeModule["handleWhatsAppAction"]>
): ReturnType<WebChannelHeavyRuntimeModule["handleWhatsAppAction"]> {
  return (await getHeavyExport("handleWhatsAppAction"))(...args);
}

export async function loadWebMedia(
  ...args: Parameters<typeof loadWebMediaImpl>
): ReturnType<typeof loadWebMediaImpl> {
  return await loadWebMediaImpl(...args);
}

export async function loadWebMediaRaw(
  ...args: Parameters<typeof loadWebMediaRawImpl>
): ReturnType<typeof loadWebMediaRawImpl> {
  return await loadWebMediaRawImpl(...args);
}

export function monitorWebChannel(
  ...args: Parameters<WebChannelHeavyRuntimeModule["monitorWebChannel"]>
): ReturnType<WebChannelHeavyRuntimeModule["monitorWebChannel"]> {
  return loadWebChannelHeavyModule().then((loaded) => loaded.monitorWebChannel(...args));
}

export async function monitorWebInbox(
  ...args: Parameters<WebChannelHeavyRuntimeModule["monitorWebInbox"]>
): ReturnType<WebChannelHeavyRuntimeModule["monitorWebInbox"]> {
  return (await getHeavyExport("monitorWebInbox"))(...args);
}

export async function optimizeImageToJpeg(
  ...args: Parameters<typeof optimizeImageToJpegImpl>
): ReturnType<typeof optimizeImageToJpegImpl> {
  return await optimizeImageToJpegImpl(...args);
}

export async function runWebHeartbeatOnce(
  ...args: Parameters<WebChannelHeavyRuntimeModule["runWebHeartbeatOnce"]>
): ReturnType<WebChannelHeavyRuntimeModule["runWebHeartbeatOnce"]> {
  return (await getHeavyExport("runWebHeartbeatOnce"))(...args);
}

export async function startWebLoginWithQr(
  ...args: Parameters<WebChannelHeavyRuntimeModule["startWebLoginWithQr"]>
): ReturnType<WebChannelHeavyRuntimeModule["startWebLoginWithQr"]> {
  return (await getHeavyExport("startWebLoginWithQr"))(...args);
}

export async function waitForWebChannelConnection(
  ...args: Parameters<WebChannelHeavyRuntimeModule["waitForWaConnection"]>
): ReturnType<WebChannelHeavyRuntimeModule["waitForWaConnection"]> {
  return (await getHeavyExport("waitForWaConnection"))(...args);
}

export async function waitForWebLogin(
  ...args: Parameters<WebChannelHeavyRuntimeModule["waitForWebLogin"]>
): ReturnType<WebChannelHeavyRuntimeModule["waitForWebLogin"]> {
  return (await getHeavyExport("waitForWebLogin"))(...args);
}

export const extractMediaPlaceholder = (
  ...args: Parameters<WebChannelHeavyRuntimeModule["extractMediaPlaceholder"]>
) => loadCurrentHeavyModuleSync().extractMediaPlaceholder(...args);

export const extractText = (...args: Parameters<WebChannelHeavyRuntimeModule["extractText"]>) =>
  loadCurrentHeavyModuleSync().extractText(...args);

export function getDefaultLocalRoots(
  ...args: Parameters<typeof getDefaultLocalRootsImpl>
): ReturnType<typeof getDefaultLocalRootsImpl> {
  return getDefaultLocalRootsImpl(...args);
}

export function resolveHeartbeatRecipients(
  ...args: Parameters<WebChannelHeavyRuntimeModule["resolveHeartbeatRecipients"]>
): ReturnType<WebChannelHeavyRuntimeModule["resolveHeartbeatRecipients"]> {
  return loadCurrentHeavyModuleSync().resolveHeartbeatRecipients(...args);
}
