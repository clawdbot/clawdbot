import type { HookConfig, HookInstallRecord } from "../config/types.hooks.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getLegacyInternalHookHandlers } from "./legacy-config.js";

function hasEnabledFlag(entry: HookConfig | undefined): boolean {
  return entry?.enabled !== false;
}

function hasEnabledEntry(entries: Record<string, HookConfig> | undefined): boolean {
  if (!entries) {
    return false;
  }
  return Object.values(entries).some(hasEnabledFlag);
}

function hasConfiguredInstalls(installs: Record<string, HookInstallRecord> | undefined): boolean {
  return installs ? Object.keys(installs).length > 0 : false;
}

export function hasConfiguredInternalHooks(config: OpenClawConfig): boolean {
  const internal = config.hooks?.internal;
  if (!internal || internal.enabled === false) {
    return false;
  }
  if (internal.enabled === true) {
    return true;
  }
  if (hasEnabledEntry(internal.entries)) {
    return true;
  }
  if ((internal.load?.extraDirs ?? []).some((dir) => dir.trim().length > 0)) {
    return true;
  }
  if (hasConfiguredInstalls(internal.installs)) {
    return true;
  }
  return getLegacyInternalHookHandlers(config).length > 0;
}

export function resolveConfiguredInternalHookNames(config: OpenClawConfig): Set<string> | null {
  const internal = config.hooks?.internal;
  if (!internal || internal.enabled === false) {
    return new Set();
  }
  if (internal.enabled === true) {
    return null;
  }

  const names = new Set<string>();
  for (const [name, entry] of Object.entries(internal.entries ?? {})) {
    const trimmed = name.trim();
    if (trimmed && hasEnabledFlag(entry)) {
      names.add(trimmed);
    }
  }
  for (const [installId, install] of Object.entries(internal.installs ?? {})) {
    const hookNames = install.hooks ?? [];
    if (hookNames.length === 0 && installId.trim()) {
      return null;
    }
    for (const hookName of hookNames) {
      const trimmedHookName = hookName.trim();
      if (trimmedHookName) {
        names.add(trimmedHookName);
      }
    }
  }

  if ((internal.load?.extraDirs ?? []).some((dir) => dir.trim().length > 0)) {
    return null;
  }
  if (getLegacyInternalHookHandlers(config).length > 0) {
    return null;
  }
  return names;
}
