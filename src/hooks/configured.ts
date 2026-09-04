// Configured hook helpers combine config and install records into active hooks.
import type { HookInstallRecord } from "../config/types.hooks.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readConfigMachineState } from "../state/config-machine-state.js";

/** Capture discovery and explicit selection from one config/install snapshot. */
export function resolveInternalHookSelection(config: OpenClawConfig): {
  configured: boolean;
  names: Set<string> | null;
  declaredNames: Set<string>;
} {
  const internal = config.hooks?.internal;
  const installs =
    readConfigMachineState<Record<string, HookInstallRecord>>("hooks.internal.installs");
  const names = new Set<string>();
  const declaredNames = new Set<string>();
  let open = (internal?.load?.extraDirs ?? []).some((dir) => dir.trim().length > 0);
  for (const [name, entry] of Object.entries(internal?.entries ?? {})) {
    const trimmed = name.trim();
    if (trimmed) {
      declaredNames.add(trimmed);
      if (entry?.enabled !== false) {
        names.add(trimmed);
      }
    }
  }
  for (const [installId, install] of Object.entries(installs ?? {})) {
    const hookNames = install.hooks ?? [];
    open ||= hookNames.length === 0 && Boolean(installId.trim());
    for (const name of hookNames) {
      const trimmed = name.trim();
      if (trimmed) {
        declaredNames.add(trimmed);
        names.add(trimmed);
      }
    }
  }
  const configured =
    internal?.enabled !== false &&
    (internal?.enabled === true ||
      Object.values(internal?.entries ?? {}).some((entry) => entry?.enabled !== false) ||
      open ||
      Object.keys(installs ?? {}).length > 0);
  return {
    configured,
    names:
      internal?.enabled === false
        ? new Set()
        : open || (declaredNames.size === 0 && internal?.enabled === true)
          ? null
          : names,
    declaredNames,
  };
}
