/**
 * Platform adapter interface — abstracts framework-specific capabilities
 * so core/ modules remain portable between the built-in and standalone versions.
 *
 * Each version implements this interface in its own `bootstrap/adapter/` directory
 * and calls `registerPlatformAdapter()` during startup.
 *
 * core/ modules access platform capabilities via `getPlatformAdapter()`.
 *
 * ## Lazy initialization
 *
 * When the adapter has not been explicitly registered yet, `getPlatformAdapter()`
 * will invoke the factory registered via `registerPlatformAdapterFactory()` to
 * create and register the adapter on first access. This eliminates fragile
 * dependency on side-effect import ordering — the adapter is guaranteed to be
 * available whenever any engine module needs it, regardless of which code path
 * triggers the first access.
 */

import type { FetchMediaOptions, FetchMediaResult, SecretInputRef } from "./types.js";

/** Platform adapter that core/ modules use for framework-specific operations. */
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
