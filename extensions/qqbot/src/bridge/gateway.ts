/**
 * Gateway entry point — thin bridge shell that constructs
 * {@link EngineAdapters} and passes them to the engine's
 * `startGateway`.
 *
 * All adapter dependencies are assembled here in one place.
 */

import { resolveRuntimeServiceVersion } from "openclaw/plugin-sdk/cli-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { EngineAdapters } from "../engine/adapter/index.js";
import {
  startGateway as coreStartGateway,
  type CoreGatewayContext,
} from "../engine/gateway/gateway.js";
import type { GatewayPluginRuntime } from "../engine/gateway/types.js";
import { initSender, registerAccount } from "../engine/messaging/sender.js";
import type { EngineLogger } from "../engine/types.js";
import * as _audioModule from "../engine/utils/audio.js";
import { formatDuration } from "../engine/utils/format.js";
import { debugLog, debugError } from "../engine/utils/log.js";
import type { ResolvedQQBotAccount } from "../types.js";
import { ensurePlatformAdapter } from "./bootstrap.js";
import { setBridgeLogger } from "./logger.js";
import { toGatewayAccount } from "./narrowing.js";
import { resolveQQBotPluginVersion } from "./plugin-version.js";
import { getQQBotRuntime, getQQBotRuntimeForEngine } from "./runtime.js";
import {
  createSdkAccessAdapter,
  createSdkHistoryAdapter,
  createSdkMentionGateAdapter,
} from "./sdk-adapter.js";

// ---- One-time startup initialization (module-level) ----

const _pluginVersion = resolveQQBotPluginVersion(import.meta.url);
initSender({
  pluginVersion: _pluginVersion,
  openclawVersion: resolveRuntimeServiceVersion(),
});

// ============ Public types ============

export interface GatewayContext {
  account: ResolvedQQBotAccount;
  abortSignal: AbortSignal;
  cfg: OpenClawConfig;
  onReady?: (data: unknown) => void;
  onResumed?: (data: unknown) => void;
  onError?: (error: Error) => void;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  channelRuntime?: {
    runtimeContexts: {
      register: (params: {
        channelId: string;
        accountId: string;
        capability: string;
        context: unknown;
        abortSignal?: AbortSignal;
      }) => { dispose: () => void };
    };
  };
}

// ============ Adapter factory ============

/**
 * Create the full set of engine adapters from the bridge layer.
 *
 * This is the **single assembly point** — all SDK → engine binding
 * happens here. The engine receives a fully-populated
 * {@link EngineAdapters} object with zero global singletons.
 */
function createEngineAdapters(_runtime: GatewayPluginRuntime): EngineAdapters {
  return {
    history: createSdkHistoryAdapter(),
    mentionGate: createSdkMentionGateAdapter(),
    access: createSdkAccessAdapter(),
    audioConvert: {
      convertSilkToWav: _audioModule.convertSilkToWav,
      isVoiceAttachment: _audioModule.isVoiceAttachment,
      formatDuration,
    },
    outboundAudio: {
      audioFileToSilkBase64: async (p: string, f?: string[]) =>
        (await _audioModule.audioFileToSilkBase64(p, f)) ?? undefined,
      isAudioFile: (p: string, m?: string) => _audioModule.isAudioFile(p, m),
      shouldTranscodeVoice: (p: string) => _audioModule.shouldTranscodeVoice(p),
      waitForFile: (p: string, ms?: number) => _audioModule.waitForFile(p, ms),
    },
    commands: {
      resolveVersion: resolveRuntimeServiceVersion,
      pluginVersion: _pluginVersion,
      approveRuntimeGetter: () => {
        const rt = getQQBotRuntime();
        return { config: rt.config };
      },
    },
  };
}

// ============ startGateway ============

/**
 * Start the Gateway WebSocket connection.
 *
 * Assembles all adapters and passes them to the engine's core gateway.
 */
export async function startGateway(ctx: GatewayContext): Promise<void> {
  ensurePlatformAdapter();

  const runtime = getQQBotRuntimeForEngine();
  const accountLogger = createAccountLogger(ctx.log, ctx.account.accountId);

  // Per-account registration (still global — sender is a leaf utility).
  registerAccount(ctx.account.appId, {
    logger: accountLogger,
    markdownSupport: ctx.account.markdownSupport,
  });
  setBridgeLogger(accountLogger);

  if (ctx.channelRuntime) {
    accountLogger.info("Registering approval.native runtime context");
    const lease = ctx.channelRuntime.runtimeContexts.register({
      channelId: "qqbot",
      accountId: ctx.account.accountId,
      capability: "approval.native",
      context: { account: ctx.account },
      abortSignal: ctx.abortSignal,
    });
    accountLogger.info(`approval.native context registered (lease=${!!lease})`);
  } else {
    accountLogger.info("No channelRuntime — skipping approval.native registration");
  }

  const coreCtx: CoreGatewayContext = {
    account: toGatewayAccount(ctx.account),
    abortSignal: ctx.abortSignal,
    cfg: ctx.cfg,
    onReady: ctx.onReady,
    onResumed: ctx.onResumed,
    onError: ctx.onError,
    log: accountLogger,
    runtime,
    adapters: createEngineAdapters(runtime),
  };

  return coreStartGateway(coreCtx);
}

// ============ Per-account logger factory ============

function createAccountLogger(
  raw: GatewayContext["log"] | undefined,
  accountId: string,
): EngineLogger {
  const prefix = `[${accountId}]`;
  const withMeta = (msg: string, meta?: Record<string, unknown>) =>
    meta && Object.keys(meta).length > 0 ? `${msg} ${JSON.stringify(meta)}` : msg;

  if (!raw) {
    return {
      info: (msg, meta) => debugLog(`${prefix} ${withMeta(msg, meta)}`),
      error: (msg, meta) => debugError(`${prefix} ${withMeta(msg, meta)}`),
      warn: (msg, meta) => debugError(`${prefix} ${withMeta(msg, meta)}`),
      debug: (msg, meta) => debugLog(`${prefix} ${withMeta(msg, meta)}`),
    };
  }
  return {
    info: (msg, meta) => raw.info(`${prefix} ${withMeta(msg, meta)}`),
    error: (msg, meta) => raw.error(`${prefix} ${withMeta(msg, meta)}`),
    warn: (msg, meta) => raw.error(`${prefix} ${withMeta(msg, meta)}`),
    debug: (msg, meta) => raw.debug?.(`${prefix} ${withMeta(msg, meta)}`),
  };
}
