import type { OpenClawConfig } from "../../config/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withProgress } from "../progress.js";

type GatewayStatusProbeKind = "connect" | "read";

let probeGatewayModulePromise: Promise<typeof import("../../gateway/probe.js")> | undefined;

async function loadProbeGatewayModule(): Promise<typeof import("../../gateway/probe.js")> {
  probeGatewayModulePromise ??= import("../../gateway/probe.js");
  return await probeGatewayModulePromise;
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
    const result = await withProgress(
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
          await callGateway({
            url: opts.url,
            token: opts.token,
            password: opts.password,
            tlsFingerprint: opts.tlsFingerprint,
            ...(opts.config ? { config: opts.config } : {}),
            method: "status",
            timeoutMs: opts.timeoutMs,
            ...(opts.configPath ? { configPath: opts.configPath } : {}),
          });
          const authProbe = await probeGateway(probeOpts).catch(() => null);
          return { ok: true as const, authProbe };
        }
        return await probeGateway(probeOpts);
      },
    );
    const auth = "auth" in result ? result.auth : result.authProbe?.auth;
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
      } as const;
    }
    return {
      ok: false,
      kind,
      capability: auth?.capability,
      auth,
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
