import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Feishu plugin module implements monitor behavior.
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { listEnabledFeishuAccounts, resolveFeishuRuntimeAccount } from "./accounts.js";
import { fetchBotIdentityForMonitor } from "./monitor.startup.js";

type MonitorFeishuOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  channelRuntime?: PluginRuntime["channel"];
  abortSignal?: AbortSignal;
  accountId?: string;
  /**
   * Optional status sink for Feishu channel health. Connected state comes
   * from transport lifecycle callbacks; transport activity is only published
   * when Feishu provides a real activity signal.
   */
  statusSink?: FeishuStatusSink;
};

/**
 * Function shape for partial channel status patches with a bound accountId.
 * Mirrors the return type of `createAccountStatusSink` from the plugin SDK
 * so the feishu plugin does not need to depend on a specific channel runtime.
 *
 * We use a structural Partial<{...}> to keep the sink type lightweight and
 * decoupled from the ChannelAccountSnapshot type. The runtime accepts any
 * subset of these fields.
 */
export type FeishuStatusSink = (patch: {
  connected?: boolean;
  lastConnectedAt?: number | null;
  lastEventAt?: number | null;
  lastTransportActivityAt?: number | null;
  lastError?: string | null;
}) => void;

const loadMonitorAccountRuntime = createLazyRuntimeModule(() => import("./monitor.account.js"));

export async function monitorFeishuProvider(opts: MonitorFeishuOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for Feishu monitor");
  }

  const log = opts.runtime?.log ?? console.log;

  if (opts.accountId) {
    const account = resolveFeishuRuntimeAccount(
      { cfg, accountId: opts.accountId },
      { requireEventSecrets: true },
    );
    if (!account.enabled || !account.configured) {
      throw new Error(`Feishu account "${opts.accountId}" not configured or disabled`);
    }
    const { monitorSingleAccount } = await loadMonitorAccountRuntime();
    return monitorSingleAccount({
      cfg,
      account,
      channelRuntime: opts.channelRuntime,
      runtime: opts.runtime,
      abortSignal: opts.abortSignal,
      ...(opts.statusSink ? { statusSink: opts.statusSink } : {}),
    });
  }

  const accounts = listEnabledFeishuAccounts(cfg);
  if (accounts.length === 0) {
    throw new Error("No enabled Feishu accounts configured");
  }

  log(
    `feishu: starting ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(", ")}`,
  );

  const { monitorSingleAccount } = await loadMonitorAccountRuntime();
  const monitorPromises: Promise<void>[] = [];
  for (const account of accounts) {
    if (opts.abortSignal?.aborted) {
      log("feishu: abort signal received during startup preflight; stopping startup");
      break;
    }

    // Probe sequentially so large multi-account startups do not burst Feishu's bot-info endpoint.
    const { botOpenId, botName, source } = await fetchBotIdentityForMonitor(account, {
      runtime: opts.runtime,
      abortSignal: opts.abortSignal,
    });

    if (opts.abortSignal?.aborted) {
      log("feishu: abort signal received during startup preflight; stopping startup");
      break;
    }

    monitorPromises.push(
      monitorSingleAccount({
        cfg,
        account,
        channelRuntime: opts.channelRuntime,
        runtime: opts.runtime,
        abortSignal: opts.abortSignal,
        botOpenIdSource: { kind: "prefetched", botOpenId, botName, source },
        ...(opts.statusSink ? { statusSink: opts.statusSink } : {}),
      }),
    );
  }

  await Promise.all(monitorPromises);
}
