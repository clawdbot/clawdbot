import path from "node:path";
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { detectBinary } from "openclaw/plugin-sdk/setup";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createIMessageRpcClient } from "./client.js";
import { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "./constants.js";
import {
  clearCachedIMessagePrivateApiStatus,
  getCachedIMessagePrivateApiStatus,
  setCachedIMessagePrivateApiStatus,
  type IMessagePrivateApiStatus,
} from "./private-api-status.js";

// Re-export for backwards compatibility
export { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "./constants.js";
export {
  getCachedIMessagePrivateApiStatus,
  imessageRpcSupportsMethod,
} from "./private-api-status.js";

export type IMessageProbe = BaseProbeResult & {
  fatal?: boolean;
  privateApi?: IMessagePrivateApiStatus;
};

export type IMessageProbeOptions = {
  cliPath?: string;
  dbPath?: string;
  platform?: NodeJS.Platform;
  runtime?: RuntimeEnv;
};

type RpcSupportResult = {
  supported: boolean;
  error?: string;
  fatal?: boolean;
};

// 5-minute TTL on the rpc-support cache lets us cope with `brew upgrade imsg`
// happening mid-process without forcing a gateway restart.
const RPC_SUPPORT_CACHE_TTL_MS = 5 * 60 * 1000;
// 10-second negative TTL on the private-api status cache lets a flurry of
// agent actions during a bridge outage avoid serializing on probe RPC.
const PRIVATE_API_NEGATIVE_TTL_MS = 10 * 1000;

type RpcSupportCacheEntry = { result: RpcSupportResult; expiresAt: number };

const rpcSupportCache = new Map<string, RpcSupportCacheEntry>();

function isDefaultLocalIMessageCliPath(cliPath: string): boolean {
  const trimmed = cliPath.trim();
  return trimmed === "imsg" || (!trimmed.includes("/") && path.basename(trimmed) === "imsg");
}

export function resolveIMessageNonMacHostError(
  cliPath: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "darwin" || !isDefaultLocalIMessageCliPath(cliPath)) {
    return undefined;
  }
  return "iMessage via the default imsg CLI must run on macOS. Run OpenClaw on the signed-in Messages Mac, or set channels.imessage.cliPath to an SSH wrapper that runs imsg on that Mac.";
}

async function probeRpcSupport(cliPath: string, timeoutMs: number): Promise<RpcSupportResult> {
  const cached = rpcSupportCache.get(cliPath);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }
  try {
    const result = await runCommandWithTimeout([cliPath, "rpc", "--help"], { timeoutMs });
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    const normalized = normalizeLowercaseStringOrEmpty(combined);
    if (normalized.includes("unknown command") && normalized.includes("rpc")) {
      const fatal = {
        supported: false,
        fatal: true,
        error: 'imsg CLI does not support the "rpc" subcommand (update imsg)',
      };
      rpcSupportCache.set(cliPath, {
        result: fatal,
        expiresAt: Date.now() + RPC_SUPPORT_CACHE_TTL_MS,
      });
      return fatal;
    }
    if (result.code === 0) {
      const supported = { supported: true };
      rpcSupportCache.set(cliPath, {
        result: supported,
        expiresAt: Date.now() + RPC_SUPPORT_CACHE_TTL_MS,
      });
      return supported;
    }
    return {
      supported: false,
      error: combined || `imsg rpc --help failed (code ${String(result.code ?? "unknown")})`,
    };
  } catch (err) {
    return { supported: false, error: String(err) };
  }
}

function parseStatusPayload(stdout: string): {
  payload: Record<string, unknown> | null;
  firstLineSnippet?: string;
} {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.toReversed()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return { payload: value as Record<string, unknown> };
      }
    } catch {
      // Continue scanning earlier JSONL records.
    }
  }
  // No JSONL line parsed. Surface a small snippet of the first non-empty
  // line so the operator can grep imsg release notes if the status output
  // schema has shifted.
  const snippet = lines[0]?.slice(0, 120);
  return { payload: null, firstLineSnippet: snippet };
}

function selectorsFromPayload(payload: Record<string, unknown>): Record<string, boolean> {
  const raw = payload.selectors;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const selectors: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "boolean") {
      selectors[key] = value;
    }
  }
  return selectors;
}

function rpcMethodsFromPayload(payload: Record<string, unknown>): string[] {
  const raw = payload.rpc_methods;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((entry): entry is string => typeof entry === "string");
}

// Probe whether the installed imsg CLI accepts `--file` on the `send-rich`
// subcommand (added by openclaw/imsg#114, which lets a single bridge call
// combine `--reply-to` and an attachment). We grep the help output rather
// than trying a real send so the probe is side-effect-free, and we resolve
// to `false` on any failure (timeout, non-zero exit, missing binary) so
// callers fall back to the legacy throw rather than silently dropping.
async function probeSendRichSupportsAttachment(
  cliPath: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const result = await runCommandWithTimeout([cliPath, "send-rich", "--help"], { timeoutMs });
    if (result.code !== 0) {
      return false;
    }
    const combined = `${result.stdout}\n${result.stderr}`;
    return /(?:^|\s)--file\b/m.test(combined);
  } catch {
    return false;
  }
}

export function clearIMessagePrivateApiCache(cliPath?: string): void {
  if (cliPath) {
    const key = cliPath.trim() || "imsg";
    clearCachedIMessagePrivateApiStatus(key);
    rpcSupportCache.delete(key);
  } else {
    clearCachedIMessagePrivateApiStatus();
    rpcSupportCache.clear();
  }
}

export async function probeIMessagePrivateApi(
  cliPath: string,
  timeoutMs: number,
  options: { forceRefresh?: boolean } = {},
): Promise<NonNullable<IMessageProbe["privateApi"]>> {
  const key = cliPath.trim() || "imsg";
  if (!options.forceRefresh) {
    const cached = getCachedIMessagePrivateApiStatus(key);
    if (cached) {
      return cached;
    }
  }
  try {
    const result = await runCommandWithTimeout([key, "status", "--json"], { timeoutMs });
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    const { payload, firstLineSnippet } = parseStatusPayload(result.stdout);
    const selectors = payload ? selectorsFromPayload(payload) : {};
    const rpcMethods = payload ? rpcMethodsFromPayload(payload) : [];
    const advancedFeatures = payload?.advanced_features === true;
    const v2Ready = payload?.v2_ready === true;
    // Probe `imsg send-rich --help` for the `--file` flag added by
    // openclaw/imsg#114. We do this even when the bridge is unavailable
    // because the help output ships with the CLI binary itself, and the
    // result is what gates whether reply-with-attachment can route through
    // the threaded send path. Treat any failure as "not supported" so
    // callers fall back to the legacy throw rather than silently dropping.
    const sendRichSupportsAttachment = await probeSendRichSupportsAttachment(key, timeoutMs);
    const status: NonNullable<IMessageProbe["privateApi"]> = {
      available: result.code === 0 && advancedFeatures && v2Ready,
      v2Ready,
      selectors,
      rpcMethods,
      cliCapabilities: { sendRichSupportsAttachment },
      ...(result.code === 0
        ? !payload && firstLineSnippet
          ? {
              error:
                `imsg status --json returned no parseable JSONL ` +
                `(first line: "${firstLineSnippet}") — output schema may have changed`,
            }
          : {}
        : { error: combined || `imsg status --json failed (code ${String(result.code)})` }),
    };
    setCachedIMessagePrivateApiStatus(
      key,
      status,
      status.available ? 0 : Date.now() + PRIVATE_API_NEGATIVE_TTL_MS,
    );
    return status;
  } catch (err) {
    const status: NonNullable<IMessageProbe["privateApi"]> = {
      available: false,
      v2Ready: false,
      selectors: {},
      rpcMethods: [],
      cliCapabilities: { sendRichSupportsAttachment: false },
      error: String(err),
    };
    setCachedIMessagePrivateApiStatus(key, status, Date.now() + PRIVATE_API_NEGATIVE_TTL_MS);
    return status;
  }
}

/**
 * Probe iMessage RPC availability.
 * @param timeoutMs - Explicit timeout in ms. If undefined, uses config or default.
 * @param opts - Additional options (cliPath, dbPath, runtime).
 */
export async function probeIMessage(
  timeoutMs?: number,
  opts: IMessageProbeOptions = {},
): Promise<IMessageProbe> {
  const cfg = opts.cliPath || opts.dbPath ? undefined : getRuntimeConfig();
  const cliPath = opts.cliPath?.trim() || cfg?.channels?.imessage?.cliPath?.trim() || "imsg";
  const dbPath = opts.dbPath?.trim() || cfg?.channels?.imessage?.dbPath?.trim();
  // Use explicit timeout if provided, otherwise fall back to config, then default
  const effectiveTimeout =
    timeoutMs ?? cfg?.channels?.imessage?.probeTimeoutMs ?? DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS;

  const nonMacHostError = resolveIMessageNonMacHostError(cliPath, opts.platform);
  if (nonMacHostError) {
    return { ok: false, fatal: true, error: nonMacHostError };
  }

  const detected = await detectBinary(cliPath);
  if (!detected) {
    return { ok: false, error: `imsg not found (${cliPath})` };
  }

  const rpcSupport = await probeRpcSupport(cliPath, effectiveTimeout);
  if (!rpcSupport.supported) {
    return {
      ok: false,
      error: rpcSupport.error ?? "imsg rpc unavailable",
      fatal: rpcSupport.fatal,
    };
  }

  const privateApi = await probeIMessagePrivateApi(cliPath, effectiveTimeout);

  const client = await createIMessageRpcClient({
    cliPath,
    dbPath,
    runtime: opts.runtime,
  });
  try {
    await client.request("chats.list", { limit: 1 }, { timeoutMs: effectiveTimeout });
    return { ok: true, privateApi };
  } catch (err) {
    return { ok: false, error: String(err), privateApi };
  } finally {
    await client.stop();
  }
}
