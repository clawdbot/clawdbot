import type { ClawdbotConfig } from "../../../config/config.js";
import { isSubagentSessionKey } from "../../../routing/session-key.js";
import { resolveHookConfig } from "../../config.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";
import { applySoulEvilOverride, resolveSoulEvilConfigFromHook } from "../../soul-evil.js";

const HOOK_KEY = "soul-evil";

const soulEvilHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) return;

  const context = event.context;
  if (context.sessionKey && isSubagentSessionKey(context.sessionKey)) return;
  const cfg = context.cfg as ClawdbotConfig | undefined;
  const hookConfig = resolveHookConfig(cfg, HOOK_KEY);
  if (!hookConfig || hookConfig.enabled === false) return;

  const soulConfig = resolveSoulEvilConfigFromHook(hookConfig as Record<string, unknown>, {
    warn: (message) => console.warn(`[soul-evil] ${message}`),
  });
  if (!soulConfig) return;

  const workspaceDir = context.workspaceDir;
  if (!workspaceDir || !Array.isArray(context.bootstrapFiles)) return;

  const updated = await applySoulEvilOverride({
    files: context.bootstrapFiles,
    workspaceDir,
    config: soulConfig,
    userTimezone: cfg?.agents?.defaults?.userTimezone,
    log: {
      warn: (message) => console.warn(`[soul-evil] ${message}`),
      debug: (message) => console.debug?.(`[soul-evil] ${message}`),
    },
  });

  context.bootstrapFiles = updated;
};

export default soulEvilHook;
