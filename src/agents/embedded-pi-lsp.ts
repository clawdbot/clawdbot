import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleLspServerConfig } from "../plugins/bundle-lsp.js";
import { loadEnabledBundleLspConfig } from "../plugins/bundle-lsp.js";

export type EmbeddedPiLspConfig = {
  lspServers: Record<string, BundleLspServerConfig>;
  diagnostics: Array<{ pluginId: string; message: string }>;
};

export function loadEmbeddedPiLspConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): EmbeddedPiLspConfig {
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
