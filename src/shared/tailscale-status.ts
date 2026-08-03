// Tailscale status helpers parse and validate status payloads from Tailscale.
import { z } from "zod";
import { safeParseJsonWithSchema } from "../utils/zod-parse.js";

export type TailscaleStatusCommandResult = {
  code: number | null;
  stdout: string;
};

export type TailscaleStatusCommandRunner = (
  argv: string[],
  opts: { timeoutMs: number },
) => Promise<TailscaleStatusCommandResult>;

const TAILSCALE_STATUS_COMMAND_CANDIDATES = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

const TailscaleStatusSchema = z.object({
  Self: z
    .object({
      DNSName: z.string().optional(),
      TailscaleIPs: z.array(z.string()).optional(),
    })
    .optional(),
});

const TailscaleServeTcpHandlerSchema = z.object({
  HTTPS: z.boolean().optional(),
});

const TailscaleServeWebServerSchema = z.object({
  Handlers: z.record(
    z.string(),
    z.object({
      Proxy: z.string().optional(),
    }),
  ),
});

const TailscaleServeServiceSchema = z.object({
  TCP: z.record(z.string(), TailscaleServeTcpHandlerSchema).optional(),
  Web: z.record(z.string(), TailscaleServeWebServerSchema).optional(),
});

const TailscaleServeConfigSchema = TailscaleServeServiceSchema.extend({
  AllowFunnel: z.record(z.string(), z.boolean()).optional(),
});

function parsePossiblyNoisyStatus(raw: string): z.infer<typeof TailscaleStatusSchema> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  return safeParseJsonWithSchema(TailscaleStatusSchema, raw.slice(start, end + 1));
}

function extractTailnetHostFromStatusJson(raw: string): string | null {
  const parsed = parsePossiblyNoisyStatus(raw);
  const dns = parsed?.Self?.DNSName;
  if (dns && dns.length > 0) {
    return dns.replace(/\.$/, "");
  }
  const ips = parsed?.Self?.TailscaleIPs ?? [];
  return ips.length > 0 ? (ips[0] ?? null) : null;
}

function parseLoopbackProxyPort(proxy: string): number | null {
  const trimmed = proxy.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  const normalized = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!(host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host))) {
      return null;
    }
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

function collectServeGatewayUrls(
  config: z.infer<typeof TailscaleServeServiceSchema>,
  gatewayPort: number,
  allowFunnel: Record<string, boolean>,
): string[] {
  const urls: string[] = [];
  for (const [hostPort, webServer] of Object.entries(config.Web ?? {})) {
    const handler = webServer.Handlers["/"];
    if (
      allowFunnel[hostPort] ||
      !handler?.Proxy ||
      parseLoopbackProxyPort(handler.Proxy) !== gatewayPort
    ) {
      continue;
    }
    try {
      const endpoint = new URL(`https://${hostPort}`);
      const port = endpoint.port || "443";
      if (config.TCP?.[port]?.HTTPS !== true) {
        continue;
      }
      urls.push(`wss://${endpoint.host}`);
    } catch {
      continue;
    }
  }
  return urls;
}

function extractServeGatewayUrls(raw: string, gatewayPort: number): string[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return [];
  }
  const parsed = safeParseJsonWithSchema(TailscaleServeConfigSchema, raw.slice(start, end + 1));
  if (!parsed) {
    return [];
  }
  // Service entries can load-balance to another node, while Funnel routes are public.
  // Pairing fallbacks must stay pinned to this node and available only inside the tailnet.
  return [
    ...new Set(collectServeGatewayUrls(parsed, gatewayPort, parsed.AllowFunnel ?? {})),
  ].toSorted();
}

/** Resolves the host published to clients for tailnet or Tailscale Serve gateway modes. */
export function resolveTailscalePublishedHost(params: {
  tailscaleMode: string;
  tailnetHost: string | null;
  serviceName?: string | null;
}): string | null {
  const tailnetHost = params.tailnetHost?.trim();
  if (!tailnetHost) {
    return null;
  }
  const serviceName =
    params.tailscaleMode === "serve" ? params.serviceName?.trim() || undefined : undefined;
  if (!serviceName) {
    return tailnetHost;
  }
  // Tailscale Serve service names compose with DNS hosts, not raw tailnet IP addresses.
  if (/^[\d.:]+$/.test(tailnetHost)) {
    return null;
  }
  const bareServiceName = serviceName.replace(/^svc:/, "");
  const tailnetSuffix = tailnetHost.split(".").slice(1).join(".");
  return tailnetSuffix ? `${bareServiceName}.${tailnetSuffix}` : null;
}

/** Runs known Tailscale status commands and returns the first DNS name or tailnet IP found. */
export async function resolveTailnetHostWithRunner(
  runCommandWithTimeout?: TailscaleStatusCommandRunner,
): Promise<string | null> {
  if (!runCommandWithTimeout) {
    return null;
  }
  for (const candidate of TAILSCALE_STATUS_COMMAND_CANDIDATES) {
    try {
      const result = await runCommandWithTimeout([candidate, "status", "--json"], {
        timeoutMs: 5000,
      });
      if (result.code !== 0) {
        continue;
      }
      const raw = result.stdout.trim();
      if (!raw) {
        continue;
      }
      const host = extractTailnetHostFromStatusJson(raw);
      if (host) {
        return host;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** Finds persistent HTTPS Serve routes whose root proxy targets this gateway port. */
export async function resolveTailscaleServeGatewayUrlsWithRunner(
  gatewayPort: number,
  runCommandWithTimeout?: TailscaleStatusCommandRunner,
): Promise<string[]> {
  if (!runCommandWithTimeout) {
    return [];
  }
  for (const candidate of TAILSCALE_STATUS_COMMAND_CANDIDATES) {
    try {
      const result = await runCommandWithTimeout([candidate, "serve", "status", "--json"], {
        timeoutMs: 5000,
      });
      if (result.code !== 0 || !result.stdout.trim()) {
        continue;
      }
      const urls = extractServeGatewayUrls(result.stdout, gatewayPort);
      if (urls.length > 0) {
        return urls;
      }
    } catch {
      continue;
    }
  }
  return [];
}
