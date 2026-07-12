import { expectDefined } from "@openclaw/normalization-core";
// Hook install record helpers read and write installed hook metadata.
import type { HookInstallRecord } from "../config/types.hooks.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Install record plus the hook pack id being updated in config. */
export type HookInstallUpdate = HookInstallRecord & { hookId: string };

/** Return config with one hook install record merged into hooks.internal.installs. */
export function recordHookInstall(cfg: OpenClawConfig, update: HookInstallUpdate): OpenClawConfig {
  const { hookId, ...record } = update;
  const installs = {
    ...cfg.hooks?.internal?.installs,
    [hookId]: {
      ...cfg.hooks?.internal?.installs?.[hookId],
      ...record,
      installedAt: record.installedAt ?? new Date().toISOString(),
    },
  };

  return {
    ...cfg,
    hooks: {
      ...cfg.hooks,
      internal: {
        ...cfg.hooks?.internal,
        installs: {
          ...installs,
          [hookId]: expectDefined(installs[hookId], "installs entry at hook id"),
        },
      },
    },
  };
}
