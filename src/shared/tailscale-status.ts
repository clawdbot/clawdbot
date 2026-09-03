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

const TailscaleServeConfigSchema = z.object({
  TCP: z.record(z.string(), TailscaleServeTcpHandlerSchema).optional(),
  Web: z.record(z.string(), TailscaleServeWebServerSchema).optional(),
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

function parseLoopbackProxyPort(proxy: string, forAdoption: boolean): number | null {
  // SDK discovery accepts the shipped proxy forms; ownership requires the exact
  // HTTP loopback root written by previous managed releases.
  if (forAdoption) {
    const match = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/.exec(proxy);
    return match ? Number(match[1]) : null;
  }
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

export function extractTailscaleServeGatewayUrls(
  raw: string,
  gatewayPort: number,
  forAdoption = false,
): string[] | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const config =
    end > start && start >= 0
      ? safeParseJsonWithSchema(TailscaleServeConfigSchema, raw.slice(start, end + 1))
      : null;
  if (!config) {
    return null;
  }
  // Services are not device routes; Funnel is excluded only from discovery.
  // Renames can leave other hostnames on a port, but the CLI clears the current
  // hostname. Adoption therefore requires the port's sole root handler.
  const web = Object.entries(config.Web ?? {});
  const urls = new Set<string>();
  for (const [hostPort, webServer] of web) {
    const handler = webServer.Handlers["/"];
    if (
      (!forAdoption && config.AllowFunnel?.[hostPort]) ||
      (forAdoption && Object.keys(webServer.Handlers).length !== 1) ||
      !handler?.Proxy ||
      parseLoopbackProxyPort(handler.Proxy, forAdoption) !== gatewayPort
    ) {
      continue;
    }
    try {
      const endpoint = new URL(`https://${hostPort}`);
      const exclusive =
        !forAdoption ||
        web.filter(([other]) => URL.parse(`https://${other}`)?.port === endpoint.port).length === 1;
      if (config.TCP?.[endpoint.port || "443"]?.HTTPS === true && exclusive) {
        urls.add(`wss://${endpoint.host}`);
      }
    } catch {
      continue;
    }
  }
  return [...urls].toSorted();
}

type TailscaleServeGatewayInspection =
  | { status: "ok"; urls: string[] }
  | { status: "unavailable" }
  | { status: "invalid" };

/** Inspects persistent Serve routes without collapsing malformed output into route absence. */
export async function inspectTailscaleServeGatewayUrlsWithRunner(
  gatewayPort: number,
  runCommandWithTimeout?: TailscaleStatusCommandRunner,
  forAdoption = false,
): Promise<TailscaleServeGatewayInspection> {
  if (!runCommandWithTimeout) {
    return { status: "unavailable" };
  }
  let sawValidStatus = false;
  let sawInvalidStatus = false;
  for (const candidate of TAILSCALE_STATUS_COMMAND_CANDIDATES) {
    try {
      const result = await runCommandWithTimeout([candidate, "serve", "status", "--json"], {
        timeoutMs: 5000,
      });
      if (result.code !== 0 || !result.stdout.trim()) {
        continue;
      }
      const urls = extractTailscaleServeGatewayUrls(result.stdout, gatewayPort, forAdoption);
      if (!urls) {
        sawInvalidStatus = true;
        continue;
      }
      sawValidStatus = true;
      if (urls.length > 0) {
        return { status: "ok", urls };
      }
    } catch {
      continue;
    }
  }
  if (sawValidStatus) {
    return { status: "ok", urls: [] };
  }
  return { status: sawInvalidStatus ? "invalid" : "unavailable" };
}

/** Resolves the host published to clients for tailnet or Tailscale Serve gateway modes. */
export function resolveTailscalePublishedHost(params: {
  tailscaleMode: string;
  tailnetHost: string | null;
  /** @deprecated Managed Gateway ingress no longer supports named Services. */
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
  // Preserve the shipped plugin SDK formatter while managed Gateway routes reject Services.
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
  const inspection = await inspectTailscaleServeGatewayUrlsWithRunner(
    gatewayPort,
    runCommandWithTimeout,
  );
  return inspection.status === "ok" ? inspection.urls : [];
}
