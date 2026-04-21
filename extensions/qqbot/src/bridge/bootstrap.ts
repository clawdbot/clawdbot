/**
 * Bootstrap the PlatformAdapter for the built-in version.
 *
 * ## Design
 *
 * The adapter is registered via two complementary mechanisms:
 *
 * 1. **Factory registration** (`registerPlatformAdapterFactory`) — a lightweight
 *    callback stored in `adapter/index.ts` that is invoked lazily by
 *    `getPlatformAdapter()` on first access. This guarantees the adapter is
 *    available regardless of module evaluation order or bundler chunk splitting.
 *
 * 2. **Eager side-effect** (`ensurePlatformAdapter()`) — called at module
 *    evaluation time when `channel.ts` imports this file. Provides the adapter
 *    immediately for code that runs synchronously during startup.
 *
 * Heavy async-only dependencies (`media-runtime`, `config-runtime`,
 * `approval-gateway-runtime`) are lazy-imported inside each async method body
 * so that this module evaluates with minimal overhead.
 *
 * Synchronous dependencies (`secret-input`, `temp-path`) are imported
 * statically at the top level so they work reliably in both production and
 * vitest (which resolves bare specifiers via `resolve.alias`, not Node CJS).
 */

import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  registerPlatformAdapter,
  registerPlatformAdapterFactory,
  hasPlatformAdapter,
  type PlatformAdapter,
} from "../engine/adapter/index.js";
import type { FetchMediaOptions, FetchMediaResult } from "../engine/adapter/types.js";
import { getBridgeLogger } from "./logger.js";

function createBuiltinAdapter(): PlatformAdapter {
  return {
    async validateRemoteUrl(_url: string, _options?: { allowPrivate?: boolean }): Promise<void> {
      // Built-in version delegates SSRF validation to fetchRemoteMedia's ssrfPolicy.
    },

    async resolveSecret(value): Promise<string | undefined> {
      if (typeof value === "string") {
        return value || undefined;
      }
      return undefined;
    },

    async downloadFile(url: string, destDir: string, filename?: string): Promise<string> {
      const { fetchRemoteMedia } = await import("openclaw/plugin-sdk/media-runtime");
      const result = await fetchRemoteMedia({ url, filePathHint: filename });
      const fs = await import("node:fs");
      const path = await import("node:path");
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      const destPath = path.join(destDir, filename ?? "download");
      fs.writeFileSync(destPath, result.buffer);
      return destPath;
    },

    async fetchMedia(options: FetchMediaOptions): Promise<FetchMediaResult> {
      const { fetchRemoteMedia } = await import("openclaw/plugin-sdk/media-runtime");
      const result = await fetchRemoteMedia({
        url: options.url,
        filePathHint: options.filePathHint,
        maxBytes: options.maxBytes,
        maxRedirects: options.maxRedirects,
        ssrfPolicy: options.ssrfPolicy,
        requestInit: options.requestInit,
      });
      return { buffer: result.buffer, fileName: result.fileName };
    },

    getTempDir(): string {
      return resolvePreferredOpenClawTmpDir();
    },

    hasConfiguredSecret(value: unknown): boolean {
      return hasConfiguredSecretInput(value);
    },

    normalizeSecretInputString(value: unknown): string | undefined {
      return normalizeSecretInputString(value) ?? undefined;
    },

    resolveSecretInputString(params: { value: unknown; path: string }): string | undefined {
      return normalizeResolvedSecretInputString(params) ?? undefined;
    },

    async resolveApproval(approvalId: string, decision: string): Promise<boolean> {
      try {
        const { loadConfig } = await import("openclaw/plugin-sdk/config-runtime");
        const { resolveApprovalOverGateway } =
          await import("openclaw/plugin-sdk/approval-gateway-runtime");
        const cfg = loadConfig();
        await resolveApprovalOverGateway({
          cfg,
          approvalId,
          decision: decision as "allow-once" | "allow-always" | "deny",
          clientDisplayName: "QQBot Approval Handler",
        });
        return true;
      } catch (err) {
        getBridgeLogger().error(`[qqbot] resolveApproval failed: ${String(err)}`);
        return false;
      }
    },
  };
}

/**
 * Ensure the built-in PlatformAdapter is registered.
 *
 * Safe to call multiple times — only registers on the first invocation.
 * Exported for backward compatibility with code that calls it explicitly.
 */
export function ensurePlatformAdapter(): void {
  if (!hasPlatformAdapter()) {
    registerPlatformAdapter(createBuiltinAdapter());
  }
}

// Register the adapter factory so getPlatformAdapter() can lazy-init even when
// this module's side-effect import hasn't executed yet (bundler reordering,
// framework-spawned approval handlers, etc.).
registerPlatformAdapterFactory(createBuiltinAdapter);

// Also eagerly register for the normal startup path (imported by channel.ts).
ensurePlatformAdapter();
