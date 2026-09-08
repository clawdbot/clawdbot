import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { TlsOptions } from "node:tls";
import {
  buildSandboxHostContentSecurityPolicy,
  buildSandboxHostProxyHtml,
  decodeSandboxHostCsp,
  SANDBOX_HOST_PATH,
} from "../agents/sandbox-host.js";
import type { PluginBoardWidgetContentKind } from "../plugins/board-widget-content-kind.types.js";
import {
  capturePluginRegistryLifecycleEpoch,
  isPluginRegistryLifecycleEpochActive,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { respondPlainText } from "./control-ui-http-utils.js";

const MCP_APP_PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), clipboard-write=()";
type PublicResourceReader = NonNullable<
  PluginBoardWidgetContentKind["resources"]["readPublicResource"]
>;

function handleMcpAppSandboxHttpRequest(req: IncomingMessage, res: ServerResponse): boolean {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    respondPlainText(res, 400, "Bad Request");
    return true;
  }
  if (url.pathname !== SANDBOX_HOST_PATH || (req.method !== "GET" && req.method !== "HEAD")) {
    return false;
  }

  let csp;
  try {
    csp = decodeSandboxHostCsp(url.searchParams.get("csp"));
  } catch {
    respondPlainText(res, 400, "invalid MCP App sandbox policy");
    return true;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", buildSandboxHostContentSecurityPolicy(csp));
  res.setHeader("Permissions-Policy", MCP_APP_PERMISSIONS_POLICY);
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Origin-Agent-Cluster", "?1");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const html = buildSandboxHostProxyHtml(csp);
  // Keep GET and HEAD representation metadata aligned while suppressing the HEAD body.
  res.setHeader("Content-Length", String(Buffer.byteLength(html)));
  res.end(req.method === "HEAD" ? undefined : html);
  return true;
}

/** Dedicated listener: only the proxy and explicitly public renderer assets, never Gateway data. */
export function createSandboxHostHttpServer(
  tlsOptions?: TlsOptions,
  resolvePluginRegistry?: () => PluginRegistry,
): HttpServer {
  // One activation owns each prepared map; reactivation cannot revive stale readers.
  const readersByEpoch = new WeakMap<object, Map<string, PublicResourceReader>>();
  const serveResource = async (req: IncomingMessage, res: ServerResponse) => {
    const registry = resolvePluginRegistry?.();
    const epoch = registry ? capturePluginRegistryLifecycleEpoch(registry) : undefined;
    if (!registry || !epoch || (req.method !== "GET" && req.method !== "HEAD")) {
      respondPlainText(res, 404, "Not Found");
      return;
    }
    let readers = readersByEpoch.get(epoch);
    if (!readers) {
      readers = new Map();
      for (const { definition } of registry.boardWidgetContentKinds.values()) {
        const read = definition.resources.readPublicResource;
        if (read) {
          for (const resourcePath of definition.resources.paths) {
            readers.set(resourcePath, read);
          }
        }
      }
      readersByEpoch.set(epoch, readers);
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const reader = readers.get(pathname);
    const resource = reader ? await reader(pathname) : undefined;
    if (
      !resource ||
      resolvePluginRegistry?.() !== registry ||
      !isPluginRegistryLifecycleEpochActive(registry, epoch)
    ) {
      respondPlainText(res, 404, "Not Found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", resource.contentType);
    res.setHeader("Content-Length", String(resource.body.byteLength));
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(req.method === "HEAD" ? undefined : resource.body);
  };
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    if (handleMcpAppSandboxHttpRequest(req, res)) {
      return;
    }
    if (!resolvePluginRegistry) {
      respondPlainText(res, 404, "Not Found");
      return;
    }
    void serveResource(req, res).catch(() =>
      respondPlainText(res, 503, "Renderer resource unavailable"),
    );
  };
  return tlsOptions ? createHttpsServer(tlsOptions, handler) : createHttpServer(handler);
}
