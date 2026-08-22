import { once } from "node:events";
import http, { type ClientRequest, type IncomingMessage } from "node:http";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import { normalizeTlsFingerprint } from "../../packages/gateway-client/src/client-address-utils.js";
import {
  buildCloudflareAccessHeaders,
  type CloudflareAccessCredentials,
} from "../../packages/gateway-client/src/cloudflare-access.js";

type NodeWorkerTransferHttpErrorReason =
  | "invalid-gateway-transport"
  | "cloudflare-access-requires-tls"
  | "invalid-tls-fingerprint"
  | "tls-fingerprint-mismatch";

export class NodeWorkerTransferHttpError extends Error {
  constructor(
    readonly reason: NodeWorkerTransferHttpErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "NodeWorkerTransferHttpError";
  }
}

const validatedTlsSocketPins = new WeakMap<TLSSocket, string>();

function transferUrl(gatewayUrl: string, routePath: string): URL {
  const gateway = new URL(gatewayUrl);
  if (gateway.protocol !== "ws:" && gateway.protocol !== "wss:") {
    throw new NodeWorkerTransferHttpError(
      "invalid-gateway-transport",
      "worker transfer gateway must use WebSocket transport",
    );
  }
  const url = new URL(gateway.toString());
  url.protocol = gateway.protocol === "wss:" ? "https:" : "http:";
  const basePath = gateway.pathname.replace(/\/$/u, "");
  url.pathname = `${basePath}${routePath}`;
  url.search = "";
  url.hash = "";
  if (url.host !== gateway.host) {
    throw new NodeWorkerTransferHttpError(
      "invalid-gateway-transport",
      "worker transfer endpoint must stay on the connected gateway host",
    );
  }
  return url;
}

function waitForTlsPin(request: ClientRequest, expectedRaw?: string): Promise<void> {
  if (!expectedRaw?.trim()) {
    return Promise.resolve();
  }
  const expected = normalizeTlsFingerprint(expectedRaw);
  if (!expected) {
    return Promise.reject(
      new NodeWorkerTransferHttpError(
        "invalid-tls-fingerprint",
        "worker transfer gateway TLS fingerprint is invalid",
      ),
    );
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let tlsSocket: TLSSocket | undefined;
    let fail: (error: Error) => void = () => {};
    let verify: () => void = () => {};
    let bindSocket: (socket: import("node:net").Socket) => void = () => {};
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      request.off("error", fail);
      request.off("socket", bindSocket);
      tlsSocket?.off("secureConnect", verify);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    fail = (error: Error) => finish(error);
    request.once("error", fail);
    bindSocket = (socket) => {
      tlsSocket = socket as TLSSocket;
      const validated = validatedTlsSocketPins.get(tlsSocket);
      if (validated) {
        finish(
          validated === expected
            ? undefined
            : new NodeWorkerTransferHttpError(
                "tls-fingerprint-mismatch",
                "worker transfer gateway TLS fingerprint mismatch",
              ),
        );
        return;
      }
      verify = () => {
        const actual = normalizeTlsFingerprint(
          tlsSocket!.getPeerCertificate().fingerprint256 ?? "",
        );
        if (!actual || expected !== actual) {
          finish(
            new NodeWorkerTransferHttpError(
              "tls-fingerprint-mismatch",
              "worker transfer gateway TLS fingerprint mismatch",
            ),
          );
          return;
        }
        validatedTlsSocketPins.set(tlsSocket!, actual);
        finish();
      };
      const peerFingerprint = tlsSocket.getPeerCertificate().fingerprint256;
      if (request.reusedSocket || peerFingerprint) {
        verify();
      } else {
        tlsSocket.once("secureConnect", verify);
      }
    };
    request.once("socket", bindSocket);
  });
}

export type NodeWorkerTransferHttpRequest = {
  gatewayUrl: string;
  tlsFingerprint?: string;
  routePath: string;
  method: "GET" | "POST";
  token: string;
  cloudflareAccess?: CloudflareAccessCredentials;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  writeBody?: (request: ClientRequest) => Promise<void>;
};

export async function openNodeWorkerTransferHttpRequest(
  params: NodeWorkerTransferHttpRequest,
): Promise<IncomingMessage> {
  const url = transferUrl(params.gatewayUrl, params.routePath);
  if (params.cloudflareAccess && url.protocol !== "https:") {
    throw new NodeWorkerTransferHttpError(
      "cloudflare-access-requires-tls",
      "Cloudflare Access credentials require HTTPS worker transfer",
    );
  }
  const transport = url.protocol === "https:" ? https : http;
  const request = transport.request(url, {
    method: params.method,
    headers: {
      ...params.headers,
      authorization: `Bearer ${params.token}`,
      ...(params.cloudflareAccess ? buildCloudflareAccessHeaders(params.cloudflareAccess) : {}),
    },
    signal: params.signal,
    ...(url.protocol === "https:" && params.tlsFingerprint
      ? { rejectUnauthorized: false, session: Buffer.alloc(0) }
      : {}),
  });
  const response = once(request, "response").then(([message]) => message as IncomingMessage);
  const send = async () => {
    if (url.protocol === "https:") {
      await waitForTlsPin(request, params.tlsFingerprint);
    }
    await params.writeBody?.(request);
    request.end();
  };
  void send().catch((error: unknown) =>
    request.destroy(error instanceof Error ? error : new Error(String(error))),
  );
  return await response;
}
