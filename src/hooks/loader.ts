import fs from "node:fs";
import { sanitizeForLog as safeLogValue } from "../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openRootFile } from "../infra/boundary-file-read.js";
import { safeRealpathSync } from "../infra/boundary-path.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { shouldIncludeHook } from "./config.js";
import { resolveInternalHookSelection } from "./configured.js";
import { resolveHookKey } from "./frontmatter.js";
import { buildImportUrl } from "./import-url.js";
import { isKnownInternalHookEventKey } from "./internal-hook-types.js";
import {
  type InternalHookHandler,
  registerInternalHook,
  setInternalHooksEnabled,
  unregisterInternalHook,
} from "./internal-hooks.js";
import { resolveFunctionModuleExport } from "./module-loader.js";
import type { HookPolicyEntry } from "./types.js";
import { prepareWorkspaceHookEntries, type HookSourceFact } from "./workspace.js";

const log = createSubsystemLogger("hooks:loader");
// Configured hooks belong to the Gateway, not to any one plugin registry generation.
type HookGeneration = {
  registrations: Array<{ event: string; handler: InternalHookHandler }>;
  discovery?: { sources: HookSourceFact[]; declaredNames: Set<string> };
  committed?: true;
};
const hookOwner = resolveGlobalSingleton<{ generation: HookGeneration }>(
  Symbol.for("openclaw.loadedInternalHookRegistrations"),
  () => ({ generation: { registrations: [] } }),
  () => resetLoadedInternalHooks(),
);

function resetLoadedInternalHooks(): void {
  for (const { event, handler } of hookOwner.generation.registrations) {
    unregisterInternalHook(event, handler);
  }
  hookOwner.generation = { registrations: [] };
}

export type PreparedInternalHooks = {
  loadedCount: number;
  commit: (options?: { initial?: boolean }) => boolean;
};

/** Imports candidate handlers without publishing registrations or changing the dispatch gate. */
export async function prepareInternalHooks(
  cfg: OpenClawConfig,
  workspaceDir: string,
  opts?: {
    managedHooksDir?: string;
    bundledHooksDir?: string;
    failureMode?: "atomic" | "best-effort";
  },
): Promise<PreparedInternalHooks> {
  const enabled = cfg.hooks?.internal?.enabled !== false;
  const previousGeneration = hookOwner.generation;
  const registrations: HookGeneration["registrations"] = [];
  let loadedCount = 0;
  const selection = resolveInternalHookSelection(cfg);
  const isNamed = (names: Set<string> | undefined, entry: HookPolicyEntry) =>
    Boolean(names?.has(entry.hook.name) || names?.has(resolveHookKey(entry.hook.name, entry)));
  const shouldLoadHook = (entry: HookPolicyEntry) =>
    (!selection.names || isNamed(selection.names, entry)) &&
    shouldIncludeHook({ entry, config: cfg });
  const discovery = selection.configured
    ? prepareWorkspaceHookEntries(workspaceDir, {
        config: cfg,
        managedHooksDir: opts?.managedHooksDir,
        bundledHooksDir: opts?.bundledHooksDir,
        ...(opts?.failureMode !== "best-effort"
          ? {
              requireValidHook: shouldLoadHook,
              previousSources: previousGeneration.discovery?.sources.filter(
                (entry) =>
                  !isNamed(previousGeneration.discovery?.declaredNames, entry) ||
                  isNamed(selection.declaredNames, entry),
              ),
            }
          : {}),
      })
    : { entries: [], sources: [] };

  for (const entry of discovery.entries) {
    if (!shouldLoadHook(entry)) {
      continue;
    }
    try {
      const hookBaseDir = safeRealpathSync(entry.hook.baseDir);
      if (!hookBaseDir) {
        throw new Error(`Hook base directory is no longer readable: ${entry.hook.baseDir}`);
      }
      const opened = await openRootFile({
        absolutePath: entry.hook.handlerPath,
        rootPath: hookBaseDir,
        boundaryLabel: "hook directory",
      });
      if (!opened.ok) {
        throw new Error(`Handler path fails boundary checks: ${entry.hook.handlerPath}`);
      }
      const safeHandlerPath = opened.path;
      fs.closeSync(opened.fd);
      if (entry.hook.source === "openclaw-workspace" || entry.hook.source === "openclaw-managed") {
        log.warn(
          `Loading ${entry.hook.source.slice("openclaw-".length)} hook code into the gateway process. Hooks are trusted local code.`,
        );
      }

      // Only mutable workspace/managed modules are cache-busted; imports may run trusted code.
      const mod = (await import(buildImportUrl(safeHandlerPath, entry.hook.source))) as Record<
        string,
        unknown
      >;
      const exportName = entry.metadata?.export ?? "default";
      const handler = resolveFunctionModuleExport<InternalHookHandler>({ mod, exportName });
      if (!handler) {
        throw new Error(`Handler '${exportName}' is not a function`);
      }
      const events = entry.metadata?.events ?? [];
      if (events.length === 0) {
        throw new Error("Hook has no events defined in metadata");
      }

      // Plugins can emit custom keys, so unknown core events remain advisory.
      const unknownEvents = events.filter((event) => !isKnownInternalHookEventKey(event));
      if (unknownEvents.length > 0) {
        log.warn(
          `Hook '${safeLogValue(entry.hook.name)}' subscribes to event${unknownEvents.length === 1 ? "" : "s"} ` +
            `${unknownEvents.map((event) => safeLogValue(event)).join(", ")} not emitted by OpenClaw core — ` +
            `likely a typo; unless a plugin emits it, the hook never fires. ` +
            `Known events: https://docs.openclaw.ai/automation/hooks`,
        );
      }
      registrations.push(...events.map((event) => ({ event, handler })));
      loadedCount++;
      log.debug(
        `Prepared hook: ${safeLogValue(entry.hook.name)} -> ${events.map((event) => safeLogValue(event)).join(", ")}${exportName !== "default" ? ` (export: ${safeLogValue(exportName)})` : ""}`,
      );
    } catch (error) {
      const message = `Failed to load hook ${safeLogValue(entry.hook.name)}: ${safeLogValue(formatErrorMessage(error))}`;
      if (opts?.failureMode !== "best-effort") {
        throw new Error(message, { cause: error });
      }
      log.error(message);
    }
  }

  return {
    loadedCount,
    commit({ initial = false } = {}) {
      // Deferred startup must not overwrite a reload, or a later Gateway lifecycle.
      if (
        initial &&
        (previousGeneration !== hookOwner.generation || previousGeneration.committed)
      ) {
        return false;
      }
      // Publish synchronously so events see one complete generation; keep unrelated listeners.
      resetLoadedInternalHooks();
      for (const { event, handler } of registrations) {
        registerInternalHook(event, handler);
      }
      hookOwner.generation = {
        registrations,
        discovery: { sources: discovery.sources, declaredNames: selection.declaredNames },
        committed: true,
      };
      setInternalHooksEnabled(enabled);
      return true;
    },
  };
}
