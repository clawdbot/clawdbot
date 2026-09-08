import { expectDefined } from "@openclaw/normalization-core";
/** Config mutation helpers used by chat commands that edit OpenClaw config. */
import { setConfigValueAtPath, unsetConfigValueAtPath } from "../../config/config-paths.js";
import {
  mutateConfigFileWithRetry,
  transformConfigFileWithRetry,
  validateConfigObjectWithPlugins,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolvePluginCapabilityConsent,
  type PluginCapabilityConsentHandler,
} from "../../plugins/capability-consent.js";
import { setPluginEnabledInConfig } from "../../plugins/toggle-config.js";

export class AutoReplyConfigMutationError extends Error {}

class AutoReplyConfigNoopMutation extends Error {}

/** Extracts user-facing mutation error text from config command failures. */
export function formatAutoReplyConfigMutationError(error: unknown): string | null {
  return error instanceof AutoReplyConfigMutationError ? error.message : null;
}

function assertValidConfig(next: Record<string, unknown>, action: string): OpenClawConfig {
  const validated = validateConfigObjectWithPlugins(next);
  if (!validated.ok) {
    const issue = expectDefined(validated.issues[0], "issues entry at 0");
    throw new AutoReplyConfigMutationError(
      `Config invalid after ${action} (${issue.path}: ${issue.message}).`,
    );
  }
  // Validation materializes runtime defaults; the mutation must retain source shape.
  return next;
}

/** Removes a config path and returns whether anything changed. */
export async function unsetConfigPath(path: string[]): Promise<boolean> {
  try {
    await mutateConfigFileWithRetry({
      base: "source",
      afterWrite: { mode: "auto" },
      mutate: (next) => {
        const removed = unsetConfigValueAtPath(next, path);
        if (!removed) {
          throw new AutoReplyConfigNoopMutation();
        }
        assertValidConfig(next, "unset");
      },
    });
    return true;
  } catch (error) {
    if (error instanceof AutoReplyConfigNoopMutation) {
      return false;
    }
    throw error;
  }
}

/** Sets and validates a config path in the source config file. */
export async function setConfigPath(path: string[], value: unknown): Promise<void> {
  await mutateConfigFileWithRetry({
    base: "source",
    afterWrite: { mode: "auto" },
    mutate: (next) => {
      setConfigValueAtPath(next, path, value);
      assertValidConfig(next, "set");
    },
  });
}

/** Toggles plugin enablement from a chat command. */
export async function setPluginEnabledFromCommand(params: {
  pluginId: string;
  enabled: boolean;
  action: "enable" | "disable";
  onCapabilityConsent?: PluginCapabilityConsentHandler;
}): Promise<void> {
  await transformConfigFileWithRetry({
    afterWrite: { mode: "auto" },
    transform: async (currentConfig) => {
      if (params.enabled) {
        await resolvePluginCapabilityConsent({
          config: currentConfig,
          pluginId: params.pluginId,
          onCapabilityConsent: params.onCapabilityConsent,
        });
      }
      const next = setPluginEnabledInConfig(
        structuredClone(currentConfig),
        params.pluginId,
        params.enabled,
      );
      return { nextConfig: assertValidConfig(next, `/plugins ${params.action}`) };
    },
  });
}

type AllowlistConfigEditResult =
  | {
      kind?: "ok" | "invalid-entry";
      changed?: boolean;
    }
  | null
  | undefined;

type MaybePromise<T> = T | Promise<T>;

type ApplyAllowlistConfigEdit = (params: {
  cfg: OpenClawConfig;
  parsedConfig: Record<string, unknown>;
  accountId?: string | null;
  scope: "dm" | "group";
  action: "add" | "remove";
  entry: string;
}) => MaybePromise<AllowlistConfigEditResult>;

/** Applies a channel allowlist edit through a plugin-provided config mutation hook. */
export async function applyAllowlistConfigMutation(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  scope: "dm" | "group";
  action: "add" | "remove";
  entry: string;
  applyConfigEdit: ApplyAllowlistConfigEdit;
}): Promise<void> {
  await transformConfigFileWithRetry({
    base: "source",
    afterWrite: { mode: "auto" },
    transform: async (currentConfig) => {
      const latestParsedConfig = structuredClone(currentConfig) as Record<string, unknown>;
      const latestEditResult = await params.applyConfigEdit({
        cfg: currentConfig,
        parsedConfig: latestParsedConfig,
        accountId: params.accountId,
        scope: params.scope,
        action: params.action,
        entry: params.entry,
      });
      if (!latestEditResult || latestEditResult.kind === "invalid-entry") {
        throw new AutoReplyConfigMutationError("Invalid allowlist entry.");
      }
      if (!latestEditResult.changed) {
        return { nextConfig: currentConfig };
      }
      return {
        nextConfig: assertValidConfig(latestParsedConfig, "update"),
      };
    },
  });
}
