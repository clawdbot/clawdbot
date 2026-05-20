import type { OpenClawConfig } from "../../config/types.js";
import type { GatewayProbeResult } from "../../gateway/probe.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { withProgress } from "../progress.js";

type GatewayStatusProbeKind = "connect" | "read";
type GatewayStatusRequireRpcProbeResult = {
  ok: true;
  authProbe: GatewayProbeResult | null;
};
type GatewayStatusProbeResult = GatewayProbeResult | GatewayStatusRequireRpcProbeResult;

const probeGatewayModuleLoader = createLazyImportLoader(() => import("../../gateway/probe.js"));

async function loadProbeGatewayModule(): Promise<typeof import("../../gateway/probe.js")> {
  return await probeGatewayModuleLoader.load();
}

function resolveProbeFailureMessage(result: {
  error?: string | null;
  close?: { code: number; reason: string } | null;
}): string {
  const closeHint = result.close
    ? `gateway closed (${result.close.code}): ${result.close.reason}`
    : null;
  if (closeHint && (!result.error || result.error === "timeout")) {
    return closeHint;
  }
  return result.error ?? closeHint ?? "gateway probe failed";
}

function resolveGatewayStatusProbeDetails(result: GatewayStatusProbeResult) {
  return "authProbe" in result ? result.authProbe : result;
}

function readRuntimeVersionFromStatusPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const runtimeVersion = (payload as { runtimeVersion?: unknown }).runtimeVersion;
  return typeof runtimeVersion === "string" && runtimeVersion.trim().length > 0
    ? runtimeVersion.trim()
    : null;
}

export async function probeGatewayStatus(opts: {
  url: string;
  token?: string;
  password?: string;
  config?: OpenClawConfig;
  tlsFingerprint?: string;
  timeoutMs: number;
  preauthHandshakeTimeoutMs?: number;
  json?: boolean;
  requireRpc?: boolean;
  configPath?: string;
}) {
  const kind = (opts.requireRpc ? "read" : "connect") satisfies GatewayStatusProbeKind;
  try {
    let statusRuntimeVersion: string | null = null;
    const result = await withProgress<GatewayStatusProbeResult>(
      {
        label: "Checking gateway status...",
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () => {
        const { probeGateway } = await loadProbeGatewayModule();
        const probeOpts = {
          url: opts.url,
          auth: {
            token: opts.token,
            password: opts.password,
          },
          tlsFingerprint: opts.tlsFingerprint,
          ...(opts.preauthHandshakeTimeoutMs !== undefined
            ? { preauthHandshakeTimeoutMs: opts.preauthHandshakeTimeoutMs }
            : {}),
          timeoutMs: opts.timeoutMs,
          includeDetails: false,
        };
        if (opts.requireRpc) {
          const { callGateway } = await import("../../gateway/call.js");
          const statusPayload = await callGateway({
            url: opts.url,
            token: opts.token,
            password: opts.password,
            tlsFingerprint: opts.tlsFingerprint,
            ...(opts.config ? { config: opts.config } : {}),
            method: "status",
            timeoutMs: opts.timeoutMs,
            ...(opts.configPath ? { configPath: opts.configPath } : {}),
          });
          statusRuntimeVersion = readRuntimeVersionFromStatusPayload(statusPayload);
          const authProbe = await probeGateway(probeOpts).catch(() => null);
          return { ok: true as const, authProbe };
        }
        return await probeGateway(probeOpts);
      },
    );
    const probeDetails = resolveGatewayStatusProbeDetails(result);
    const auth = probeDetails?.auth;
    const server = probeDetails?.server;
    const serverSummary = server ? { server } : {};
    const version = server?.version ?? ("authProbe" in result ? statusRuntimeVersion : null);
    if (result.ok) {
      return {
        ok: true,
        kind,
        capability:
          kind === "read"
            ? auth?.capability && auth.capability !== "unknown"
              ? auth.capability
              : "read_only"
            : auth?.capability,
        auth,
        ...serverSummary,
        ...(version != null ? { version } : {}),
      } as const;
    }
    return {
      ok: false,
      kind,
      capability: auth?.capability,
      auth,
      ...serverSummary,
      ...(version != null ? { version } : {}),
      error: resolveProbeFailureMessage(result),
    } as const;
  } catch (err) {
    return {
      ok: false,
      kind,
      error: formatErrorMessage(err),
    } as const;
  }
}
