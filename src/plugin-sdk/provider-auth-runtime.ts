// Public runtime auth helpers for provider plugins.

import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveApiKeyForProvider as resolveModelApiKeyForProvider } from "../agents/model-auth.js";

export { resolveEnvApiKey } from "../agents/model-auth-env.js";
export {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "../agents/api-key-rotation.js";
export { NON_ENV_SECRETREF_MARKER } from "../agents/model-auth-markers.js";
export {
  requireApiKey,
  resolveAwsSdkEnvVarName,
  type ResolvedProviderAuth,
} from "../agents/model-auth-runtime-shared.js";
export type { ProviderPreparedRuntimeAuth } from "../plugins/types.js";
export type { ResolvedProviderRuntimeAuth } from "../plugins/runtime/model-auth-types.js";

export type OAuthCallbackResult = { code: string; state: string };

// IdP-host allowlist for CORS echo on the loopback OAuth callback. Plugins
// pass the hosts that may legitimately issue preflights against the redirect
// URI; everything else gets a 204 with no `Access-Control-Allow-*` headers,
// which is safe for normal browser navigation but blocks cross-origin script
// reads. The empty allowlist (default) leaves the legacy permissive SDK
// behavior in place for existing callers.
export function buildOAuthCallbackOriginResolver(
  allowedHosts: readonly string[] | undefined,
): (originHeader: string | string[] | undefined) => string | undefined {
  if (!allowedHosts || allowedHosts.length === 0) {
    return () => undefined;
  }
  const normalized = new Set(
    allowedHosts.map((host) => host.trim().toLowerCase()).filter((host) => host.length > 0),
  );
  if (normalized.size === 0) {
    return () => undefined;
  }
  return (originHeader) => {
    const value = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (!value) {
      return undefined;
    }
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:") {
        return undefined;
      }
      return normalized.has(parsed.host.toLowerCase()) ? parsed.origin : undefined;
    } catch {
      return undefined;
    }
  };
}

export function generateOAuthState(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function parseOAuthCallbackInput(
  input: string,
  messages: {
    missingState?: string;
    invalidInput?: string;
  } = {},
): OAuthCallbackResult | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { error: "No input provided" };
  }

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code) {
      return { error: "Missing 'code' parameter in URL" };
    }
    if (!state) {
      return { error: messages.missingState ?? "Missing 'state' parameter in URL" };
    }
    return { code, state };
  } catch {
    return { error: messages.invalidInput ?? "Paste the full redirect URL, not just the code." };
  }
}

export async function waitForLocalOAuthCallback(params: {
  expectedState: string;
  timeoutMs: number;
  port: number;
  callbackPath: string;
  redirectUri: string;
  successTitle: string;
  progressMessage?: string;
  hostname?: string;
  onProgress?: (message: string) => void;
  // IdP host allowlist for CORS preflight echo. Pass the canonical authority
  // host(s) (e.g. `["auth.example.com"]`) that may issue an `OPTIONS` against
  // the redirect URI. When omitted, legacy permissive SDK behavior is
  // preserved for existing provider login flows.
  corsOriginAllowlist?: readonly string[];
}): Promise<OAuthCallbackResult> {
  const hostname = params.hostname ?? "localhost";
  const escapedSuccessTitle = escapeHtmlText(params.successTitle);
  const resolveOAuthCallbackOrigin = buildOAuthCallbackOriginResolver(params.corsOriginAllowlist);
  const hasCorsOriginAllowlist =
    params.corsOriginAllowlist?.some((host) => host.trim().length > 0) ?? false;

  return new Promise<OAuthCallbackResult>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    const server = createServer((req, res) => {
      try {
        applyOAuthCallbackCorsHeaders(
          req,
          res,
          hasCorsOriginAllowlist ? resolveOAuthCallbackOrigin : undefined,
        );
        const requestUrl = new URL(req.url ?? "/", `http://${hostname}:${params.port}`);
        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }
        if (requestUrl.pathname !== params.callbackPath) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain");
          res.end("Not found");
          return;
        }
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET, OPTIONS");
          res.setHeader("Content-Type", "text/plain");
          res.end("Method not allowed");
          return;
        }

        const error = requestUrl.searchParams.get("error");
        const code = requestUrl.searchParams.get("code")?.trim();
        const state = requestUrl.searchParams.get("state")?.trim();

        if (error) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end(`Authentication failed: ${error}`);
          finish(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code || !state) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end("Missing code or state");
          finish(new Error("Missing OAuth code or state"));
          return;
        }

        if (state !== params.expectedState) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end("Invalid state");
          finish(new Error("OAuth state mismatch"));
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          "<!doctype html><html><head><meta charset='utf-8'/></head>" +
            `<body><h2>${escapedSuccessTitle}</h2>` +
            "<p>You can close this window and return to OpenClaw.</p></body></html>",
        );

        finish(undefined, { code, state });
      } catch (err) {
        finish(err instanceof Error ? err : new Error("OAuth callback failed"));
      }
    });

    const finish = (err?: Error, result?: OAuthCallbackResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      try {
        server.close();
      } catch {
        // ignore close errors
      }
      if (err) {
        reject(err);
      } else if (result) {
        resolve(result);
      }
    };

    server.once("error", (err) => {
      finish(err instanceof Error ? err : new Error("OAuth callback server error"));
    });

    server.listen(params.port, hostname, () => {
      params.onProgress?.(
        params.progressMessage ?? `Waiting for OAuth callback on ${params.redirectUri}...`,
      );
    });

    timeout = setTimeout(() => {
      finish(new Error("OAuth callback timeout"));
    }, params.timeoutMs);
  });
}

function applyOAuthCallbackCorsHeaders(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  resolveOrigin?: (originHeader: string | string[] | undefined) => string | undefined,
): void {
  const origin =
    resolveOrigin === undefined
      ? typeof req.headers.origin === "string" && isHttpOrigin(req.headers.origin)
        ? req.headers.origin
        : undefined
      : resolveOrigin(req.headers.origin);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  }
  if (resolveOrigin !== undefined && !origin) {
    return;
  }

  const requestedHeaders = req.headers["access-control-request-headers"];
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    typeof requestedHeaders === "string" && requestedHeaders.trim().length > 0
      ? requestedHeaders
      : "content-type",
  );
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "600");
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type ResolveApiKeyForProvider = typeof import("../agents/model-auth.js").resolveApiKeyForProvider;
type GetRuntimeAuthForModel =
  typeof import("../plugins/runtime/runtime-model-auth.runtime.js").getRuntimeAuthForModel;
type RuntimeModelAuthModule = typeof import("../plugins/runtime/runtime-model-auth.runtime.js");
const RUNTIME_MODEL_AUTH_CANDIDATES = [
  "./runtime-model-auth.runtime",
  "../plugins/runtime/runtime-model-auth.runtime",
] as const;
const RUNTIME_MODEL_AUTH_EXTENSIONS = [".js", ".ts", ".mjs", ".mts", ".cjs", ".cts"] as const;

function resolveRuntimeModelAuthModuleHref(): string {
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  for (const relativeBase of RUNTIME_MODEL_AUTH_CANDIDATES) {
    for (const ext of RUNTIME_MODEL_AUTH_EXTENSIONS) {
      const candidate = path.resolve(baseDir, `${relativeBase}${ext}`);
      if (fs.existsSync(candidate)) {
        return pathToFileURL(candidate).href;
      }
    }
  }
  throw new Error(`Unable to resolve runtime model auth module from ${import.meta.url}`);
}

async function loadRuntimeModelAuthModule(): Promise<RuntimeModelAuthModule> {
  return (await import(resolveRuntimeModelAuthModuleHref())) as RuntimeModelAuthModule;
}

export async function resolveApiKeyForProvider(
  params: Parameters<ResolveApiKeyForProvider>[0],
): Promise<Awaited<ReturnType<ResolveApiKeyForProvider>>> {
  const runtimeAuth = await loadRuntimeModelAuthModule();
  const resolveApiKeyForProvider =
    typeof runtimeAuth.resolveApiKeyForProvider === "function"
      ? runtimeAuth.resolveApiKeyForProvider
      : resolveModelApiKeyForProvider;
  return resolveApiKeyForProvider(params);
}

export async function getRuntimeAuthForModel(
  params: Parameters<GetRuntimeAuthForModel>[0],
): Promise<Awaited<ReturnType<GetRuntimeAuthForModel>>> {
  const { getRuntimeAuthForModel } = await loadRuntimeModelAuthModule();
  return getRuntimeAuthForModel(params);
}
