import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  attachPluginInstallOwnerMigrations,
  resolvePluginInstallTransaction,
  resolvePluginInstallTransactionRequest,
  settlePluginInstallTransactions,
  type PluginInstallTransaction,
} from "./install-transaction.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "./install.js";
import {
  disablePluginAfterUpdateFailure,
  repairOpenClawPeerLinksForNpmInstalls,
} from "./update-config.js";
import type {
  PluginUpdateChannelFallback,
  PluginUpdateLogger,
  PluginUpdateOutcome,
  PluginUpdateSummary,
} from "./update-source.js";

export function recordPluginUpdateFailure(params: {
  config: OpenClawConfig;
  disableOnFailure?: boolean;
  dryRun?: boolean;
  logger: PluginUpdateLogger;
  outcomes: PluginUpdateOutcome[];
  pluginId: string;
  message: string;
  options?: {
    channelFallback?: PluginUpdateChannelFallback;
    code?: string;
    installedPayloadRunnable?: boolean;
  };
}): { config: OpenClawConfig; changed: boolean } {
  const options = params.options ?? {};
  const preserveInstalledPayload =
    options.code === PLUGIN_INSTALL_ERROR_CODE.NPM_METADATA_FAILURE &&
    options.installedPayloadRunnable === true;
  if (params.disableOnFailure && !params.dryRun && !preserveInstalledPayload) {
    const message =
      `Disabled "${params.pluginId}" after plugin update failure; OpenClaw will continue without it. ` +
      params.message;
    params.logger.warn?.(message);
    params.outcomes.push({
      pluginId: params.pluginId,
      status: "skipped",
      message,
      ...(options.channelFallback ? { channelFallback: options.channelFallback } : {}),
    });
    return {
      config: disablePluginAfterUpdateFailure(params.config, params.pluginId),
      changed: true,
    };
  }
  params.outcomes.push({
    pluginId: params.pluginId,
    status: "error",
    message: params.message,
    ...(options.channelFallback ? { channelFallback: options.channelFallback } : {}),
  });
  return { config: params.config, changed: false };
}

export function createPluginUpdateTransactionState(params: object) {
  return {
    transactions: [] as PluginInstallTransaction[],
    installOwnerMigrations: {} as Record<string, string>,
    transactionSink: resolvePluginInstallTransactionRequest(params)?.transactionSink,
  };
}

export function recordPluginUpdateTransaction(
  state: ReturnType<typeof createPluginUpdateTransactionState>,
  result: object,
  pluginId: string,
  resolvedPluginId: string,
): void {
  const transaction = resolvePluginInstallTransaction(result);
  if (transaction) {
    state.transactions.push(transaction);
    state.transactionSink?.push(transaction);
  }
  if (resolvedPluginId !== pluginId) {
    state.installOwnerMigrations[pluginId] = resolvedPluginId;
  }
}

export async function finalizePluginUpdateSummary(params: {
  config: OpenClawConfig;
  changed: boolean;
  outcomes: PluginUpdateOutcome[];
  ranNpmInstaller: boolean;
  logger: PluginUpdateLogger;
  transactionState: ReturnType<typeof createPluginUpdateTransactionState>;
}): Promise<PluginUpdateSummary> {
  let changed = params.changed;
  if (params.ranNpmInstaller) {
    try {
      changed =
        (await repairOpenClawPeerLinksForNpmInstalls({
          config: params.config,
          logger: params.logger,
        })) || changed;
    } catch (error) {
      await settlePluginInstallTransactions(params.transactionState.transactions, "rollback");
      throw error;
    }
  }
  const summary = { config: params.config, changed, outcomes: params.outcomes };
  return Object.keys(params.transactionState.installOwnerMigrations).length > 0
    ? attachPluginInstallOwnerMigrations(summary, params.transactionState.installOwnerMigrations)
    : summary;
}
