/**
 * Engine adapter layer — all external dependency interfaces unified here.
 *
 * This directory is the **single source of truth** for every interface
 * the engine uses to talk to the outside world.
 *
 * ## Two-layer DI architecture
 *
 * ### Layer 1: EngineAdapters (构造参数注入 — preferred)
 *
 * Used for capabilities consumed within the pipeline call stack.
 * Injected once via {@link CoreGatewayContext.adapters}, threaded
 * through {@link InboundPipelineDeps.adapters}, consumed by stages.
 *
 * - {@link HistoryPort} — group history record/build/clear
 * - {@link MentionGatePort} — mention + command gate evaluation
 * - {@link AudioConvertPort} — inbound SILK→WAV conversion
 * - {@link OutboundAudioPort} — outbound WAV→SILK conversion
 * - {@link CommandsPort} — slash-command version/approve dependencies
 *
 * ### Layer 2: PlatformAdapter (global singleton — leaf utilities)
 *
 * Used by leaf utility functions (`file-utils`, `image-size`,
 * `platform`, `config/resolve`) that sit outside the pipeline and
 * cannot receive a `deps` parameter. Registered once at startup.
 *
 * - {@link PlatformAdapter} — SSRF, secrets, media fetch, temp dir
 */

import type { FetchMediaOptions, FetchMediaResult, SecretInputRef } from "./types.js";

// ============ Re-exports (port interfaces) ============

export type { HistoryPort, HistoryEntryLike } from "./history.port.js";
export type {
  MentionGatePort,
  MentionFacts,
  MentionPolicy,
  MentionGateDecision,
  ImplicitMentionKind,
} from "./mention-gate.port.js";
export type { AudioConvertPort, OutboundAudioPort } from "./audio.port.js";
export type { CommandsPort, ApproveRuntimeGetter } from "./commands.port.js";

// ============ EngineAdapters (aggregated port injection) ============

/**
 * Aggregated adapter ports injected via `CoreGatewayContext.adapters`.
 *
 * All fields are required — the bridge layer must provide every adapter.
 * The engine no longer falls back to built-in implementations.
 */
export interface EngineAdapters {
  /** Group history record/build/clear — backed by SDK `reply-history`. */
  history: import("./history.port.js").HistoryPort;
  /** Mention + command gate evaluation — backed by SDK `channel-mention-gating`. */
  mentionGate: import("./mention-gate.port.js").MentionGatePort;
  /** Inbound audio conversion (SILK→WAV, voice detection). */
  audioConvert: import("./audio.port.js").AudioConvertPort;
  /** Outbound audio conversion (WAV→SILK, audio detection). */
  outboundAudio: import("./audio.port.js").OutboundAudioPort;
  /** Slash-command dependencies (version, approve runtime). */
  commands: import("./commands.port.js").CommandsPort;
}

// ============ PlatformAdapter (global singleton — leaf utilities) ============

/** Platform adapter that leaf utilities use for framework-specific operations. */
export interface PlatformAdapter {
  /** Validate that a remote URL is safe to fetch (SSRF protection). */
  validateRemoteUrl(url: string, options?: { allowPrivate?: boolean }): Promise<void>;

  /** Resolve a secret value (SecretInput or plain string) to a plain string. */
  resolveSecret(value: string | SecretInputRef | undefined): Promise<string | undefined>;

  /** Download a remote file to a local directory. Returns the local file path. */
  downloadFile(url: string, destDir: string, filename?: string): Promise<string>;

  /**
   * Fetch remote media with SSRF protection.
   * Replaces direct usage of `fetchRemoteMedia` from `plugin-sdk/media-runtime`.
   */
  fetchMedia(options: FetchMediaOptions): Promise<FetchMediaResult>;

  /** Return the preferred temporary directory for the platform. */
  getTempDir(): string;

  /** Check whether a secret input value has been configured (non-empty). */
  hasConfiguredSecret(value: unknown): boolean;

  /**
   * Normalize a raw SecretInput value into a plain string.
   * For unresolved references (e.g. `$secret:xxx`), returns the raw reference string.
   */
  normalizeSecretInputString(value: unknown): string | undefined;

  /**
   * Resolve a SecretInput value into the final plain-text secret.
   * For secret references, resolves them to actual values via the platform's secret store.
   */
  resolveSecretInputString(params: { value: unknown; path: string }): string | undefined;

  /**
   * Submit an approval decision to the framework's approval gateway.
   * Optional — only available when the framework supports approvals.
   * Returns true if the decision was submitted successfully.
   */
  resolveApproval?(approvalId: string, decision: string): Promise<boolean>;
}

let _adapter: PlatformAdapter | null = null;
let _adapterFactory: (() => PlatformAdapter) | null = null;

/** Register the platform adapter. Called once during startup. */
export function registerPlatformAdapter(adapter: PlatformAdapter): void {
  _adapter = adapter;
}

/**
 * Register a factory that creates the PlatformAdapter on first access.
 *
 * This decouples adapter availability from side-effect import ordering.
 * The factory is invoked at most once — on the first `getPlatformAdapter()`
 * call when no adapter has been explicitly registered yet.
 */
export function registerPlatformAdapterFactory(factory: () => PlatformAdapter): void {
  _adapterFactory = factory;
}

/**
 * Get the registered platform adapter.
 *
 * If no adapter has been explicitly registered yet but a factory was provided
 * via `registerPlatformAdapterFactory()`, the factory is invoked to create
 * and register the adapter automatically.
 */
export function getPlatformAdapter(): PlatformAdapter {
  if (!_adapter && _adapterFactory) {
    _adapter = _adapterFactory();
  }
  if (!_adapter) {
    throw new Error(
      "PlatformAdapter not registered. Call registerPlatformAdapter() during bootstrap.",
    );
  }
  return _adapter;
}

/** Check whether a platform adapter has been registered (or can be created from a factory). */
export function hasPlatformAdapter(): boolean {
  return _adapter !== null || _adapterFactory !== null;
}
