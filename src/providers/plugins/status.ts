import type { ClawdbotConfig } from "../../config/config.js";
import type { ProviderAccountSnapshot, ProviderPlugin } from "./types.js";

// Provider docking: status snapshots flow through plugin.status hooks here.
export async function buildProviderAccountSnapshot<ResolvedAccount>(params: {
  plugin: ProviderPlugin<ResolvedAccount>;
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: ProviderAccountSnapshot;
  probe?: unknown;
  audit?: unknown;
}): Promise<ProviderAccountSnapshot> {
  const account = params.plugin.config.resolveAccount(
    params.cfg,
    params.accountId,
  );
  if (params.plugin.status?.buildAccountSnapshot) {
    return await params.plugin.status.buildAccountSnapshot({
      account,
      cfg: params.cfg,
      runtime: params.runtime,
      probe: params.probe,
      audit: params.audit,
    });
  }
  const enabled = params.plugin.config.isEnabled
    ? params.plugin.config.isEnabled(account, params.cfg)
    : account && typeof account === "object"
      ? (account as { enabled?: boolean }).enabled
      : undefined;
  const configured = params.plugin.config.isConfigured
    ? await params.plugin.config.isConfigured(account, params.cfg)
    : undefined;
  return {
    accountId: params.accountId,
    enabled,
    configured,
  };
}
