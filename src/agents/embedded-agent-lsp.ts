/**
 * Loads bundle-provided LSP server config for embedded-agent sessions.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleLspServerConfig } from "../plugins/bundle-lsp.js";
import { loadEnabledBundleLspConfig } from "../plugins/bundle-lsp.js";

type EmbeddedAgentLspConfig = {
  lspServers: Record<string, BundleLspServerConfig>;
  diagnostics: Array<{ pluginId: string; message: string }>;
};

/** Resolve enabled embedded-agent LSP servers and diagnostics. */
export function loadEmbeddedAgentLspConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): EmbeddedAgentLspConfig {
  const bundleLsp = loadEnabledBundleLspConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  // User-configured LSP servers could override bundle defaults here in the future.
  return {
    lspServers: { ...bundleLsp.config.lspServers },
    diagnostics: bundleLsp.diagnostics,
  };
}
