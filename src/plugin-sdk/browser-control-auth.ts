// Browser control auth helpers resolve plugin browser credentials from OpenClaw config.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

/** Browser control credentials resolved from config, env, or generated setup state. */
export type BrowserControlAuth = {
  /** Bearer token accepted by the browser control HTTP surface. */
  token?: string;
  /** Password fallback for deployments that expose password-based browser control auth. */
  password?: string;
};

/** Inputs used when resolving or creating browser control auth for the active config. */
type EnsureBrowserControlAuthParams = {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

/** Resolved auth plus the generated token when this call created one. */
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

let cachedBrowserControlAuthSurface: BrowserControlAuthSurface | undefined;

function loadBrowserControlAuthSurface(): BrowserControlAuthSurface {
  // Browser owns auth generation and env precedence; this SDK wrapper only keeps
  // the lazy public facade stable for plugin authors.
  cachedBrowserControlAuthSurface ??=
    loadBundledPluginPublicSurfaceModuleSync<BrowserControlAuthSurface>({
      dirName: "browser",
      artifactBasename: "browser-control-auth.js",
    });
  return cachedBrowserControlAuthSurface;
}

/** Resolves browser control auth from config/env without generating new credentials. */
export function resolveBrowserControlAuth(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): BrowserControlAuth {
  return loadBrowserControlAuthSurface().resolveBrowserControlAuth(cfg, env);
}

/** Returns whether browser control auth should be generated for this environment. */
export function shouldAutoGenerateBrowserAuth(env: NodeJS.ProcessEnv): boolean {
  return loadBrowserControlAuthSurface().shouldAutoGenerateBrowserAuth(env);
}

/** Ensures browser control auth exists, returning any token generated during the call. */
export async function ensureBrowserControlAuth(
  params: EnsureBrowserControlAuthParams,
): Promise<EnsureBrowserControlAuthResult> {
  return await loadBrowserControlAuthSurface().ensureBrowserControlAuth(params);
}
