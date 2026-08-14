/**
 * Dynamic loader for hook handlers
 *
 * Loads hook handlers from external modules based on configuration
 * and from directory-based discovery (bundled, managed, workspace)
 */

import fs from "node:fs";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openRootFile } from "../infra/boundary-file-read.js";
import { safeRealpathSync } from "../infra/boundary-path.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { shouldIncludeHook } from "./config.js";
import { hasConfiguredInternalHooks, resolveConfiguredInternalHookNames } from "./configured.js";
import { resolveHookKey } from "./frontmatter.js";
import { buildImportUrl } from "./import-url.js";
import { isKnownInternalHookEventKey } from "./internal-hook-types.js";
import type { InternalHookHandler } from "./internal-hooks.js";
import { registerInternalHook, unregisterInternalHook } from "./internal-hooks.js";
import { resolveFunctionModuleExport } from "./module-loader.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

const log = createSubsystemLogger("hooks:loader");
const LOADED_INTERNAL_HOOK_REGISTRATIONS_KEY = Symbol.for(
  "openclaw.loadedInternalHookRegistrations",
);
const loadedHookRegistrations = resolveGlobalSingleton<
  Array<{ event: string; handler: InternalHookHandler }>
>(
  LOADED_INTERNAL_HOOK_REGISTRATIONS_KEY,
  () => [],
  () => resetLoadedInternalHooks(),
  "plugin-registry",
);

function safeLogValue(value: string): string {
  return sanitizeForLog(value);
}

function maybeWarnTrustedHookSource(source: string): void {
  if (source === "openclaw-workspace") {
    log.warn(
      "Loading workspace hook code into the gateway process. Workspace hooks are trusted local code.",
    );
    return;
  }
  if (source === "openclaw-managed") {
    log.warn(
      "Loading managed hook code into the gateway process. Managed hooks are trusted local code.",
    );
  }
}

function resetLoadedInternalHooks(): void {
  while (loadedHookRegistrations.length > 0) {
    const registration = loadedHookRegistrations.pop();
    if (!registration) {
      continue;
    }
    unregisterInternalHook(registration.event, registration.handler);
  }
}

/**
 * Load and register all hook handlers
 *
 * Loads hooks from directory-based discovery (bundled, managed, workspace).
 *
 * @param cfg - OpenClaw configuration
 * @param workspaceDir - Workspace directory for hook discovery
 * @returns Number of handlers successfully loaded
 *
 * @example
 * ```ts
 * const config = await getRuntimeConfig();
 * const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
 * const count = await loadInternalHooks(config, workspaceDir);
 * console.log(`Loaded ${count} hook handlers`);
 * ```
 */
export async function loadInternalHooks(
  cfg: OpenClawConfig,
  workspaceDir: string,
  opts?: {
    managedHooksDir?: string;
    bundledHooksDir?: string;
  },
): Promise<number> {
  resetLoadedInternalHooks();

  if (!hasConfiguredInternalHooks(cfg)) {
    return 0;
  }

  let loadedCount = 0;
  const configuredNames = resolveConfiguredInternalHookNames(cfg);

  try {
    const hookEntries = loadWorkspaceHookEntries(workspaceDir, {
      config: cfg,
      managedHooksDir: opts?.managedHooksDir,
      bundledHooksDir: opts?.bundledHooksDir,
    });

    // Filter by eligibility
    const eligible = hookEntries.filter((entry) => {
      if (configuredNames) {
        const hookKey = resolveHookKey(entry.hook.name, entry);
        if (!configuredNames.has(entry.hook.name) && !configuredNames.has(hookKey)) {
          return false;
        }
      }
      return shouldIncludeHook({ entry, config: cfg });
    });

    for (const entry of eligible) {
      try {
        const hookBaseDir = safeRealpathSync(entry.hook.baseDir);
        if (!hookBaseDir) {
          log.error(
            `Hook '${safeLogValue(entry.hook.name)}' base directory is no longer readable: ${safeLogValue(entry.hook.baseDir)}`,
          );
          continue;
        }
        const opened = await openRootFile({
          absolutePath: entry.hook.handlerPath,
          rootPath: hookBaseDir,
          boundaryLabel: "hook directory",
        });
        if (!opened.ok) {
          log.error(
            `Hook '${safeLogValue(entry.hook.name)}' handler path fails boundary checks: ${safeLogValue(entry.hook.handlerPath)}`,
          );
          continue;
        }
        const safeHandlerPath = opened.path;
        fs.closeSync(opened.fd);
        maybeWarnTrustedHookSource(entry.hook.source);

        // Import handler module — only cache-bust mutable (workspace/managed) hooks
        const importUrl = buildImportUrl(safeHandlerPath, entry.hook.source);
        const mod = (await import(importUrl)) as Record<string, unknown>;

        // Get handler function (default or named export)
        const exportName = entry.metadata?.export ?? "default";
        const handler = resolveFunctionModuleExport<InternalHookHandler>({
          mod,
          exportName,
        });

        if (!handler) {
          log.error(
            `Handler '${safeLogValue(exportName)}' from ${safeLogValue(entry.hook.name)} is not a function`,
          );
          continue;
        }

        // Register for all events listed in metadata
        const events = entry.metadata?.events ?? [];
        if (events.length === 0) {
          log.warn(`Hook '${safeLogValue(entry.hook.name)}' has no events defined in metadata`);
          continue;
        }

        // Core never emits keys outside the known set, so these are almost
        // always typos that leave the hook silently dead (a plugin could emit
        // custom keys via plugin-sdk/hook-runtime, hence advisory: warn but
        // still register).
        const unknownEvents = events.filter((event) => !isKnownInternalHookEventKey(event));
        if (unknownEvents.length > 0) {
          log.warn(
            `Hook '${safeLogValue(entry.hook.name)}' subscribes to event${unknownEvents.length === 1 ? "" : "s"} ` +
              `${unknownEvents.map((event) => safeLogValue(event)).join(", ")} not emitted by OpenClaw core — ` +
              `likely a typo; unless a plugin emits it, the hook never fires. ` +
              `Known events: https://docs.openclaw.ai/automation/hooks`,
          );
        }

        for (const event of events) {
          registerInternalHook(event, handler);
          loadedHookRegistrations.push({ event, handler });
        }

        log.debug(
          `Registered hook: ${safeLogValue(entry.hook.name)} -> ${events.map((event) => safeLogValue(event)).join(", ")}${exportName !== "default" ? ` (export: ${safeLogValue(exportName)})` : ""}`,
        );
        loadedCount++;
      } catch (err) {
        log.error(
          `Failed to load hook ${safeLogValue(entry.hook.name)}: ${safeLogValue(formatErrorMessage(err))}`,
        );
      }
    }
  } catch (err) {
    log.error(`Failed to load directory-based hooks: ${safeLogValue(formatErrorMessage(err))}`);
  }

  return loadedCount;
}
