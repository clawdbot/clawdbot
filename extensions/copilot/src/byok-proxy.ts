// Copilot BYOK transport proxy keeps OpenClaw in charge of outbound network policy.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { ResolvedCopilotProvider } from "./provider-bridge.js";

const LOOPBACK_HOST = "127.0.0.1";

type CopilotByokProxyHandle = {
  close: () => Promise<void>;
  provider: ResolvedCopilotProvider;
};

type HeaderValue = string | number | string[] | undefined;
type ProviderConfig = NonNullable<ResolvedCopilotProvider["provider"]>;

export async function createCopilotByokProxy(
  resolvedProvider: ResolvedCopilotProvider,
): Promise<CopilotByokProxyHandle | undefined> {
  if (resolvedProvider.mode !== "byok") {
    return undefined;
  }
  const providerConfig = resolvedProvider.provider;
  if (!providerConfig?.baseUrl) {
    throw new Error("[copilot-attempt] BYOK requires a provider baseUrl");
  }

  const targetBaseUrl = new URL(providerConfig.baseUrl);
  const nonce = randomBytes(12).toString("hex");
  const targetPathPrefix = trimTrailingSlash(targetBaseUrl.pathname);
  const proxyPathPrefix = `/${nonce}${targetPathPrefix}`;
  const acceptsAzureSdkPaths = providerConfig.type === "azure";
  const upstreamBearerAuthorization = resolveUpstreamBearerAuthorization(providerConfig);
  const activeFetches = new Set<AbortController>();
  const server = createServer((req, res) => {
    void handleProxyRequest(req, res, {
      acceptsAzureSdkPaths,
      activeFetches,
      proxyPathPrefix,
      targetBaseUrl,
      targetPathPrefix,
      upstreamBearerAuthorization,
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("[copilot-attempt] failed to start BYOK network proxy");
  }

  const proxyBaseUrl = `http://${LOOPBACK_HOST}:${address.port}${proxyPathPrefix}`;
  const sdkBaseUrl = acceptsAzureSdkPaths
    ? `http://${LOOPBACK_HOST}:${address.port}`
    : proxyBaseUrl;
  return {
    provider: {
      ...resolvedProvider,
      provider: {
        ...providerConfig,
        baseUrl: sdkBaseUrl,
      },
    },
    close: async () => {
      for (const controller of activeFetches) {
        controller.abort();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // The proxy is private and ephemeral. Do not let a client's keep-alive
        // socket delay shutdown after every upstream request has been aborted.
        server.closeAllConnections();
      });
    },
  };
}

async function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  params: {
    acceptsAzureSdkPaths: boolean;
    activeFetches: Set<AbortController>;
    proxyPathPrefix: string;
    targetBaseUrl: URL;
    targetPathPrefix: string;
    upstreamBearerAuthorization: string | undefined;
  },
): Promise<void> {
  let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>> | undefined;
  const upstreamAbort = new AbortController();
  params.activeFetches.add(upstreamAbort);
  const abortUpstream = () => upstreamAbort.abort();
  req.on("aborted", abortUpstream);
  res.on("close", () => {
    if (!res.writableEnded) {
      abortUpstream();
    }
  });
  try {
    const canInjectBearerAuthorization = isNonceProtectedProxyRequest(req, params.proxyPathPrefix);
    const url = resolveTargetUrl(req, params);
    if (!url) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    guarded = await fetchWithSsrFGuard({
      url: url.toString(),
      init: {
        method: req.method,
        headers: buildProxyRequestHeaders(req.headers, {
          upstreamBearerAuthorization: canInjectBearerAuthorization
            ? params.upstreamBearerAuthorization
            : undefined,
        }),
        signal: upstreamAbort.signal,
        ...(body ? { body: toFetchBody(body) } : {}),
      },
      auditContext: "copilot-byok-provider",
      requireHttps: true,
    });
    res.writeHead(
      guarded.response.status,
      guarded.response.statusText,
      normalizeProxyResponseHeaders(guarded.response.headers),
    );
    if (!guarded.response.body) {
      res.end();
      return;
    }
    await finished(
      Readable.fromWeb(guarded.response.body as unknown as NodeReadableStream<Uint8Array>).pipe(
        res,
      ),
    );
  } catch (error) {
    if (res.destroyed || res.writableEnded) {
      return;
    }
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    res.writeHead(502);
    res.end(error instanceof Error ? error.message : "BYOK provider proxy failed");
  } finally {
    req.off("aborted", abortUpstream);
    params.activeFetches.delete(upstreamAbort);
    await guarded?.release().catch(() => undefined);
  }
}

function resolveTargetUrl(
  req: IncomingMessage,
  params: {
    acceptsAzureSdkPaths: boolean;
    proxyPathPrefix: string;
    targetBaseUrl: URL;
    targetPathPrefix: string;
  },
): URL | undefined {
  const incomingUrl = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
  if (
    incomingUrl.pathname !== params.proxyPathPrefix &&
    !incomingUrl.pathname.startsWith(`${params.proxyPathPrefix}/`)
  ) {
    return params.acceptsAzureSdkPaths && isAzureSdkProxyPath(incomingUrl.pathname)
      ? resolveDirectTargetUrl(incomingUrl, params.targetBaseUrl)
      : undefined;
  }
  const suffix = incomingUrl.pathname.slice(params.proxyPathPrefix.length);
  const targetUrl = new URL(params.targetBaseUrl);
  targetUrl.pathname = `${params.targetPathPrefix}${suffix}` || "/";
  for (const [key, value] of incomingUrl.searchParams) {
    targetUrl.searchParams.append(key, value);
  }
  return targetUrl;
}

function resolveDirectTargetUrl(incomingUrl: URL, targetBaseUrl: URL): URL {
  const targetUrl = new URL(targetBaseUrl);
  targetUrl.pathname = incomingUrl.pathname;
  for (const [key, value] of incomingUrl.searchParams) {
    targetUrl.searchParams.append(key, value);
  }
  return targetUrl;
}

function isAzureSdkProxyPath(pathname: string): boolean {
  return pathname === "/openai" || pathname.startsWith("/openai/");
}

function isNonceProtectedProxyRequest(req: IncomingMessage, proxyPathPrefix: string): boolean {
  const incomingUrl = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
  return (
    incomingUrl.pathname === proxyPathPrefix ||
    incomingUrl.pathname.startsWith(`${proxyPathPrefix}/`)
  );
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function toFetchBody(body: Buffer): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return copy;
}

function normalizeProxyRequestHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (isHopByHopHeader(key) || key.toLowerCase() === "accept-encoding") {
      continue;
    }
    const normalized = normalizeHeaderValue(value);
    if (normalized !== undefined) {
      out[key] = normalized;
    }
  }
  out["accept-encoding"] = "identity";
  return out;
}

function buildProxyRequestHeaders(
  headers: IncomingMessage["headers"],
  params: { upstreamBearerAuthorization: string | undefined },
): Record<string, string> {
  const out = normalizeProxyRequestHeaders(headers);
  if (params.upstreamBearerAuthorization && !hasHeader(out, "authorization")) {
    // The SDK declares bearerToken as Authorization auth, but some BYOK
    // adapter paths can omit it before reaching our loopback proxy. The proxy
    // owns the final guarded hop, so inject only when the SDK left it absent.
    out["authorization"] = params.upstreamBearerAuthorization;
  }
  return out;
}

function resolveUpstreamBearerAuthorization(providerConfig: ProviderConfig): string | undefined {
  const bearerToken = providerConfig.bearerToken?.trim();
  return bearerToken ? `Bearer ${bearerToken}` : undefined;
}

function normalizeProxyResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!isHopByHopHeader(key) && !isContentEncodingHeader(key)) {
      out[key] = value;
    }
  });
  return out;
}

function normalizeHeaderValue(value: HeaderValue): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function hasHeader(headers: Record<string, string>, target: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

function isHopByHopHeader(key: string): boolean {
  switch (key.toLowerCase()) {
    case "connection":
    case "host":
    case "keep-alive":
    case "proxy-authenticate":
    case "proxy-authorization":
    case "te":
    case "trailer":
    case "transfer-encoding":
    case "upgrade":
      return true;
    default:
      return false;
  }
}

function isContentEncodingHeader(key: string): boolean {
  switch (key.toLowerCase()) {
    case "content-encoding":
    case "content-length":
      return true;
    default:
      return false;
  }
}

function trimTrailingSlash(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "" : trimmed;
}
