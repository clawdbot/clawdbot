import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

export type BrowserControlAuth = {
  token?: string;
  password?: string;
};

type EnsureBrowserControlAuthParams = {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

type EnsureBrowserControlAuthResult = {
  auth: BrowserControlAuth;
  generatedToken?: string;
};

type BrowserControlAuthSurface = {
  resolveBrowserControlAuth: (cfg?: OpenClawConfig, env?: NodeJS.ProcessEnv) => BrowserControlAuth;
  shouldAutoGenerateBrowserAuth: (env: NodeJS.ProcessEnv) => boolean;
  ensureBrowserControlAuth: (
    params: EnsureBrowserControlAuthParams,
  ) => Promise<EnsureBrowserControlAuthResult>;
};

function loadBrowserControlAuthSurface(): BrowserControlAuthSurface {
  return loadBundledPluginPublicSurfaceModuleSync<BrowserControlAuthSurface>({
    dirName: "browser",
    artifactBasename: "browser-control-auth.js",
  });
}

export function resolveBrowserControlAuth(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): BrowserControlAuth {
  return loadBrowserControlAuthSurface().resolveBrowserControlAuth(cfg, env);
}

export function shouldAutoGenerateBrowserAuth(env: NodeJS.ProcessEnv): boolean {
  return loadBrowserControlAuthSurface().shouldAutoGenerateBrowserAuth(env);
}

export async function ensureBrowserControlAuth(
  params: EnsureBrowserControlAuthParams,
): Promise<EnsureBrowserControlAuthResult> {
  return await loadBrowserControlAuthSurface().ensureBrowserControlAuth(params);
}
