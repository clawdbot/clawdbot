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
  tlsFingerprint?: string;
  timeoutMs: number;
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
        if (opts.requireRpc) {
          const { callGateway } = await import("../../gateway/call.js");
          await callGateway({
            url: opts.url,
            token: opts.token,
            password: opts.password,
            tlsFingerprint: opts.tlsFingerprint,
            method: "status",
            timeoutMs: opts.timeoutMs,
            ...(opts.configPath ? { configPath: opts.configPath } : {}),
          });
          const { probeGateway } = await loadProbeGatewayModule();
          const authProbe = await probeGateway({
            url: opts.url,
            auth: {
              token: opts.token,
              password: opts.password,
            },
            tlsFingerprint: opts.tlsFingerprint,
            timeoutMs: opts.timeoutMs,
            includeDetails: false,
          }).catch(() => null);
          return { ok: true as const, authProbe };
        }
        const { probeGateway } = await loadProbeGatewayModule();
        return await probeGateway({
          url: opts.url,
          auth: {
            token: opts.token,
            password: opts.password,
          },
          tlsFingerprint: opts.tlsFingerprint,
          timeoutMs: opts.timeoutMs,
          includeDetails: false,
        });
      },
    );
    const auth =
      "auth" in result ? result.auth : "authProbe" in result ? result.authProbe?.auth : undefined;
    if (result.ok) {
      return {
        ok: true,
        kind,
        capability:
          kind === "read"
            ? auth?.capability && auth.capability !== "unknown"
              ? auth.capability
              : // The status RPC proves read access even when a follow-up hello probe
                // cannot recover richer scope metadata.
                "read_only"
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
