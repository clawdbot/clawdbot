import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { TLSSocket } from "node:tls";
import { normalizeTlsFingerprint } from "../../packages/gateway-client/src/client-address-utils.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const GATEWAY_HTTP_PROBE_MAX_RESPONSE_CHARS = 1024;

export type GatewayHttpProbeResponse = {
  statusCode: number;
  body: string;
};

type GatewayLocalProbeTarget = {
  url: string;
  tlsFingerprint?: string;
};

export type ConfiguredGatewayLocalProbe = {
  requestHttp(params: {
    host: string;
    pathname: "/healthz" | "/readyz";
    port: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<GatewayHttpProbeResponse | null>;
  resolveWebSocketTarget(port: number): Promise<GatewayLocalProbeTarget | null>;
};

export function normalizeGatewayHttpProbeHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

export async function requestGatewayLocalHttpProbe(params: {
  host: string;
  pathname: "/healthz" | "/readyz";
  port: number;
  timeoutMs: number;
  tlsFingerprint?: string;
  signal?: AbortSignal;
}): Promise<GatewayHttpProbeResponse | null> {
  params.signal?.throwIfAborted();
  if (params.timeoutMs <= 0) {
    return null;
  }
  const response = await new Promise<GatewayHttpProbeResponse | null>((resolve) => {
    let settled = false;
    const finish = (result: GatewayHttpProbeResponse | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const request = params.tlsFingerprint ? httpsRequest : httpRequest;
    const req = request(
      {
        hostname: normalizeGatewayHttpProbeHost(params.host),
        port: params.port,
        path: params.pathname,
        method: "GET",
        timeout: params.timeoutMs,
        ...(params.signal ? { signal: params.signal } : {}),
        // Self-signed local Gateway certificates are trusted only by the exact
        // configured pin below; never accept them on ordinary HTTPS requests.
        ...(params.tlsFingerprint ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        if (params.tlsFingerprint) {
          const peerFingerprint =
            res.socket instanceof TLSSocket
              ? normalizeTlsFingerprint(res.socket.getPeerCertificate().fingerprint256 ?? "")
              : "";
          if (peerFingerprint !== normalizeTlsFingerprint(params.tlsFingerprint)) {
            res.resume();
            finish(null);
            return;
          }
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length + chunk.length > GATEWAY_HTTP_PROBE_MAX_RESPONSE_CHARS) {
            res.destroy();
            finish(null);
            return;
          }
          body += chunk;
        });
        res.once("end", () => {
          finish({ statusCode: res.statusCode ?? 0, body });
        });
        res.once("error", () => {
          finish(null);
        });
      },
    );
    const deadline = setTimeout(() => {
      req.destroy();
      finish(null);
    }, params.timeoutMs);
    req.once("timeout", () => {
      req.destroy();
      finish(null);
    });
    req.once("error", () => {
      finish(null);
    });
    req.end();
  });
  params.signal?.throwIfAborted();
  return response;
}

export function createConfiguredGatewayLocalProbe(
  config: OpenClawConfig,
): ConfiguredGatewayLocalProbe {
  const tlsConfig = config.gateway?.tls;
  let tlsFingerprint: string | undefined;
  let tlsFingerprintLoad: Promise<string | undefined> | null = null;

  const resolveTlsFingerprint = async (): Promise<string | undefined> => {
    if (tlsConfig?.enabled !== true) {
      return undefined;
    }
    if (!tlsFingerprint) {
      tlsFingerprintLoad ??= import("../infra/tls/gateway.js")
        .then(({ loadGatewayTlsServerRuntime }) =>
          loadGatewayTlsServerRuntime({ ...tlsConfig, autoGenerate: false }),
        )
        .then((gatewayTls) => gatewayTls.fingerprintSha256)
        .catch(() => undefined);
      const gatewayTls = await tlsFingerprintLoad;
      tlsFingerprintLoad = null;
      tlsFingerprint = gatewayTls;
    }
    return tlsFingerprint;
  };

  return {
    async requestHttp(params) {
      const resolvedTlsFingerprint = await resolveTlsFingerprint();
      if (tlsConfig?.enabled === true && !resolvedTlsFingerprint) {
        return null;
      }
      return await requestGatewayLocalHttpProbe({
        ...params,
        ...(resolvedTlsFingerprint ? { tlsFingerprint: resolvedTlsFingerprint } : {}),
      });
    },
    async resolveWebSocketTarget(port) {
      const resolvedTlsFingerprint = await resolveTlsFingerprint();
      if (tlsConfig?.enabled === true) {
        return resolvedTlsFingerprint
          ? { url: `wss://127.0.0.1:${port}`, tlsFingerprint: resolvedTlsFingerprint }
          : null;
      }
      return { url: `ws://127.0.0.1:${port}` };
    },
  };
}
