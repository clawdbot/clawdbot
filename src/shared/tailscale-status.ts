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
