import type { PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { defaultCodexAppInventoryCache } from "./app-server/app-inventory-cache.js";
import {
  isCodexAppServerIndeterminateRequestCancellationError,
  isCodexAppServerPrewriteRequestCancellationError,
} from "./app-server/client.js";
import { refreshCodexPluginAppRuntimeState } from "./app-server/plugin-activation.js";
import { CodexAppServerRpcError } from "./app-server/rpc-error.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import {
  formatCodexPluginReadiness,
  readCodexPluginReadiness,
} from "./command-plugins-readiness.js";
import type { CodexPluginCommandContext } from "./command-plugins-runtime.js";

/** Rechecks hosted tools without changing plugin policy or replacing the current thread. */
export async function recheckCodexPluginReadiness(
  context: CodexPluginCommandContext,
  configKey: string,
): Promise<PluginCommandResult> {
  const params = { context, current: context.current, configKey };
  const before = await readCodexPluginReadiness(params);
  if (
    !before.openClawEnabled ||
    !before.summary?.installed ||
    !before.summary.enabled ||
    before.summary.availability === "DISABLED_BY_ADMIN" ||
    before.summary.installPolicy === "NOT_AVAILABLE" ||
    !before.detail?.apps.length
  ) {
    return formatCodexPluginReadiness(before);
  }

  try {
    await refreshCodexPluginAppRuntimeState({
      request: context.request,
      appCache: defaultCodexAppInventoryCache,
      appCacheKey: context.appCacheKey,
      targetAppIds: before.detail.apps.map((app) => app.id),
    });
  } catch (error) {
    // Scope changes take precedence over a transport failure from the old account.
    await context.validateCurrent();
    const target = formatCodexDisplayText(before.commandId);
    const retryCommand = `/codex plugins recheck ${before.commandId}`;
    const reason =
      error instanceof CodexAppServerRpcError && error.code === -32601
        ? "This Codex app-server does not support the required app inventory methods. Update the Codex plugin and retry."
        : (isCodexAppServerIndeterminateRequestCancellationError(error) ||
              isCodexAppServerPrewriteRequestCancellationError(error)) &&
            "reason" in error &&
            error.reason === "aborted"
          ? "The recheck was cancelled."
          : "Hosted app tools could not be refreshed. Check the Codex connection and try again.";
    return {
      text: `Could not recheck ${target}. ${reason} Run ${retryCommand}. Previous inventory was not confirmed; no conversation policy was changed.`,
    };
  }
  const refreshed = await readCodexPluginReadiness(params);
  return formatCodexPluginReadiness(refreshed, 1, { rechecked: true });
}
