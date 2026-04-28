import crypto from "node:crypto";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { getRuntimeConfig, replaceConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { ensureGatewayStartupAuth } from "../gateway/startup-auth.js";

export type BrowserControlAuth = {
  token?: string;
  password?: string;
};

export function resolveBrowserControlAuth(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): BrowserControlAuth {
  const auth = resolveGatewayAuth({
    authConfig: cfg?.gateway?.auth,
    env,
    tailscaleMode: cfg?.gateway?.tailscale?.mode,
  });
  const token = normalizeOptionalString(auth.token) ?? "";
  const password = normalizeOptionalString(auth.password) ?? "";
  const mode = auth.mode;

  switch (mode) {
    case "password":
    case "trusted-proxy":
      return { password: password || undefined };
    case "token":
    case "none":
      return { token: token || undefined };
    default:
      return {};
  }
}

export function shouldAutoGenerateBrowserAuth(env: NodeJS.ProcessEnv): boolean {
  const nodeEnv = normalizeLowercaseStringOrEmpty(env.NODE_ENV);
  if (nodeEnv === "test") {
    return false;
  }
  const vitest = normalizeLowercaseStringOrEmpty(env.VITEST);
  if (vitest && vitest !== "0" && vitest !== "false" && vitest !== "off") {
    return false;
  }
  return true;
}

function hasExplicitNonStringGatewayCredentialForMode(params: {
  cfg?: OpenClawConfig;
  mode: "none" | "trusted-proxy";
}): boolean {
  const { cfg, mode } = params;
  const auth = cfg?.gateway?.auth;
  if (!auth) {
    return false;
  }
  if (mode === "none") {
    return auth.token != null && typeof auth.token !== "string";
  }
  return auth.password != null && typeof auth.password !== "string";
}

function generateBrowserControlToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

async function generateAndPersistBrowserControlToken(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<{
  auth: BrowserControlAuth;
  generatedToken?: string;
}> {
  const token = generateBrowserControlToken();
  const nextCfg: OpenClawConfig = {
    ...params.cfg,
    gateway: {
      ...params.cfg.gateway,
      auth: {
        ...params.cfg.gateway?.auth,
        token,
      },
    },
  };
  await replaceConfigFile({
    nextConfig: nextCfg,
    afterWrite: { mode: "auto" },
  });

  // Re-read to stay consistent with any concurrent config writer.
  const persistedAuth = resolveBrowserControlAuth(getRuntimeConfig(), params.env);
  if (persistedAuth.token || persistedAuth.password) {
    return {
      auth: persistedAuth,
      generatedToken: persistedAuth.token === token ? token : undefined,
    };
  }

  return { auth: { token }, generatedToken: token };
}

async function generateAndPersistBrowserControlPassword(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<{
  auth: BrowserControlAuth;
  generatedToken?: string;
}> {
  const password = generateBrowserControlToken();
  const nextCfg: OpenClawConfig = {
    ...params.cfg,
    gateway: {
      ...params.cfg.gateway,
      auth: {
        ...params.cfg.gateway?.auth,
        password,
      },
    },
  };
  await replaceConfigFile({
    nextConfig: nextCfg,
    afterWrite: { mode: "auto" },
  });

  // Re-read to stay consistent with any concurrent config writer.
  const persistedAuth = resolveBrowserControlAuth(getRuntimeConfig(), params.env);
  if (persistedAuth.token || persistedAuth.password) {
    return {
      auth: persistedAuth,
      generatedToken: persistedAuth.password === password ? password : undefined,
    };
  }

  return { auth: { password }, generatedToken: password };
}

export async function ensureBrowserControlAuth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  auth: BrowserControlAuth;
  generatedToken?: string;
}> {
  const env = params.env ?? process.env;
  const auth = resolveBrowserControlAuth(params.cfg, env);
  if (auth.token || auth.password) {
    return { auth };
  }
  if (!shouldAutoGenerateBrowserAuth(env)) {
    return { auth };
  }

  // Respect explicit password mode even if currently unset.
  if (params.cfg.gateway?.auth?.mode === "password") {
    return { auth };
  }

  // Re-read latest config to avoid racing with concurrent config writers.
  const latestCfg = getRuntimeConfig();
  const latestAuth = resolveBrowserControlAuth(latestCfg, env);
  if (latestAuth.token || latestAuth.password) {
    return { auth: latestAuth };
  }
  if (latestCfg.gateway?.auth?.mode === "password") {
    return { auth: latestAuth };
  }
  const latestMode = latestCfg.gateway?.auth?.mode;
  if (latestMode === "none" || latestMode === "trusted-proxy") {
    if (
      hasExplicitNonStringGatewayCredentialForMode({
        cfg: latestCfg,
        mode: latestMode,
      })
    ) {
      // Avoid silently overwriting SecretRef-style gateway auth inputs with generated plaintext.
      // Startup will fail closed if no resolved browser auth is available.
      return { auth: latestAuth };
    }
    if (latestMode === "trusted-proxy") {
      // gateway.auth.mode=trusted-proxy must never be persisted with gateway.auth.token.
      // Persist a browser-only shared secret through gateway.auth.password instead so
      // out-of-process loopback clients can resolve it from config/env.
      return await generateAndPersistBrowserControlPassword({ cfg: latestCfg, env });
    }
    return await generateAndPersistBrowserControlToken({ cfg: latestCfg, env });
  }

  const ensured = await ensureGatewayStartupAuth({
    cfg: latestCfg,
    env,
    persist: true,
  });
  const ensuredAuth = {
    token: ensured.auth.token,
    password: ensured.auth.password,
  };
  return {
    auth: ensuredAuth,
    generatedToken: ensured.generatedToken,
  };
}
