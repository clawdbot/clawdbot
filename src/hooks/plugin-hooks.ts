import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ClawdbotPluginApi } from "../plugins/types.js";
import type { HookEntry } from "./types.js";
import { shouldIncludeHook } from "./config.js";
import { loadHookEntriesFromDir } from "./workspace.js";
import type { InternalHookHandler } from "./internal-hooks.js";

export type PluginHookLoadResult = {
  hooks: HookEntry[];
  loaded: number;
  skipped: number;
  errors: string[];
};

function resolveHookDir(api: ClawdbotPluginApi, dir: string): string {
  if (path.isAbsolute(dir)) return dir;
  return path.resolve(path.dirname(api.source), dir);
}

function normalizePluginHookEntry(api: ClawdbotPluginApi, entry: HookEntry): HookEntry {
  return {
    ...entry,
    hook: {
      ...entry.hook,
      source: "clawdbot-plugin",
      pluginId: api.id,
    },
    clawdbot: {
      ...entry.clawdbot,
      hookKey: entry.clawdbot?.hookKey ?? `${api.id}:${entry.hook.name}`,
      events: entry.clawdbot?.events ?? [],
    },
  };
}

async function loadHookHandler(
  entry: HookEntry,
  api: ClawdbotPluginApi,
): Promise<InternalHookHandler | null> {
  try {
    const url = pathToFileURL(entry.hook.handlerPath).href;
    const cacheBustedUrl = `${url}?t=${Date.now()}`;
    const mod = (await import(cacheBustedUrl)) as Record<string, unknown>;
    const exportName = entry.clawdbot?.export ?? "default";
    const handler = mod[exportName];
    if (typeof handler === "function") {
      return handler as InternalHookHandler;
    }
    api.logger.warn?.(`[hooks] ${entry.hook.name} handler is not a function`);
    return null;
  } catch (err) {
    api.logger.warn?.(`[hooks] Failed to load ${entry.hook.name}: ${String(err)}`);
    return null;
  }
}

export async function registerPluginHooksFromDir(
  api: ClawdbotPluginApi,
  dir: string,
): Promise<PluginHookLoadResult> {
  const resolvedDir = resolveHookDir(api, dir);
  const hooks = loadHookEntriesFromDir({
    dir: resolvedDir,
    source: "clawdbot-plugin",
    pluginId: api.id,
  });

  const result: PluginHookLoadResult = {
    hooks,
    loaded: 0,
    skipped: 0,
    errors: [],
  };

  for (const entry of hooks) {
    const normalizedEntry = normalizePluginHookEntry(api, entry);
    const events = normalizedEntry.clawdbot?.events ?? [];
    if (events.length === 0) {
      api.logger.warn?.(`[hooks] ${entry.hook.name} has no events; skipping`);
      api.registerHook(events, async () => undefined, {
        entry: normalizedEntry,
        register: false,
      });
      result.skipped += 1;
      continue;
    }

    const handler = await loadHookHandler(entry, api);
    if (!handler) {
      result.errors.push(`[hooks] Failed to load ${entry.hook.name}`);
      api.registerHook(events, async () => undefined, {
        entry: normalizedEntry,
        register: false,
      });
      result.skipped += 1;
      continue;
    }

    const eligible = shouldIncludeHook({ entry: normalizedEntry, config: api.config });
    api.registerHook(events, handler, {
      entry: normalizedEntry,
      register: eligible,
    });

    if (eligible) {
      result.loaded += 1;
    } else {
      result.skipped += 1;
    }
  }

  return result;
}
