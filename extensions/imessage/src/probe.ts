import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { detectBinary } from "openclaw/plugin-sdk/setup";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { createIMessageRpcClient } from "./client.js";
import { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "./constants.js";

// Re-export for backwards compatibility
export { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "./constants.js";

export type IMessageProbe = BaseProbeResult & {
  fatal?: boolean;
};

export type IMessageProbeOptions = {
  cliPath?: string;
  dbPath?: string;
  runtime?: RuntimeEnv;
};

type RpcSupportResult = {
  supported: boolean;
  error?: string;
  fatal?: boolean;
};

const rpcSupportCache = new Map<string, RpcSupportResult>();

async function probeRpcSupport(cliPath: string, timeoutMs: number): Promise<RpcSupportResult> {
  const cached = rpcSupportCache.get(cliPath);
  if (cached) {
    return cached;
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
      rpcSupportCache.set(cliPath, fatal);
      return fatal;
    }
    if (result.code === 0) {
      const supported = { supported: true };
      rpcSupportCache.set(cliPath, supported);
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

  const client = await createIMessageRpcClient({
    cliPath,
    dbPath,
    runtime: opts.runtime,
  });
  try {
    await client.request("chats.list", { limit: 1 }, { timeoutMs: effectiveTimeout });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    await client.stop();
  }
}
