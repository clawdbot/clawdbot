import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { CONFIG_DIR, ensureDir } from "../utils.js";

export function normalizeWideAreaDomain(raw?: string | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}

export function resolveWideAreaDiscoveryDomain(params?: {
  env?: NodeJS.ProcessEnv;
  configDomain?: string | null;
}): string | null {
  const env = params?.env ?? process.env;
  const candidate = params?.configDomain ?? env.OPENCLAW_WIDE_AREA_DOMAIN ?? null;
  return normalizeWideAreaDomain(candidate);
}

function zoneFilenameForDomain(domain: string): string {
  return `${domain.replace(/\.$/, "")}.db`;
}

export function getWideAreaZonePath(domain: string): string {
  return path.join(CONFIG_DIR, "dns", zoneFilenameForDomain(domain));
}

function dnsLabel(raw: string, fallback: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(raw)
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  const out = normalized.length > 0 ? normalized : fallback;
  return out.length <= 63 ? out : out.slice(0, 63);
}

function txtQuote(value: string): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
  return `"${escaped}"`;
}

function formatYyyyMmDd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function nextSerial(existingSerial: number | null, now: Date): number {
  const today = formatYyyyMmDd(now);
  const base = Number.parseInt(`${today}01`, 10);
  if (!existingSerial || !Number.isFinite(existingSerial)) {
    return base;
  }
  const existing = String(existingSerial);
  if (existing.startsWith(today)) {
    return existingSerial + 1;
  }
  return base;
}

function extractSerial(zoneText: string): number | null {
  const match = zoneText.match(/^\s*@\s+IN\s+SOA\s+\S+\s+\S+\s+(\d+)\s+/m);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractContentHash(zoneText: string): string | null {
  const match = zoneText.match(/^\s*;\s*openclaw-content-hash:\s*(\S+)\s*$/m);
  return match?.[1] ?? null;
}

function computeContentHash(body: string): string {
  // Cheap stable hash; avoids importing crypto (and keeps deterministic across runtimes).
  let h = 2166136261;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export type WideAreaGatewayZoneOpts = {
  domain: string;
  gatewayPort: number;
  displayName: string;
  tailnetIPv4: string;
  tailnetIPv6?: string;
  gatewayTlsEnabled?: boolean;
  gatewayTlsFingerprintSha256?: string;
  gatewayDirectReachable?: boolean;
  instanceLabel?: string;
  hostLabel?: string;
  tailnetDns?: string;
  sshPort?: number;
  cliPath?: string;
};

function renderZone(opts: WideAreaGatewayZoneOpts & { serial: number }): string {
  const hostname = os.hostname().split(".")[0] ?? "openclaw";
  const hostLabel = dnsLabel(opts.hostLabel ?? hostname, "openclaw");
  const instanceLabel = dnsLabel(opts.instanceLabel ?? `${hostname}-gateway`, "openclaw-gw");
  const domain = normalizeWideAreaDomain(opts.domain) ?? "local.";

  const txt = [
    `displayName=${opts.displayName.trim() || hostname}`,
    `role=gateway`,
    `transport=gateway`,
    `gatewayPort=${opts.gatewayPort}`,
  ];
  if (opts.gatewayTlsEnabled) {
    txt.push(`gatewayTls=1`);
    if (opts.gatewayTlsFingerprintSha256) {
      txt.push(`gatewayTlsSha256=${opts.gatewayTlsFingerprintSha256}`);
    }
  }
  if (opts.gatewayDirectReachable) {
    txt.push(`gatewayDirectReachable=1`);
  }
  if (opts.tailnetDns?.trim()) {
    txt.push(`tailnetDns=${opts.tailnetDns.trim()}`);
  }
  if (typeof opts.sshPort === "number" && opts.sshPort > 0) {
    txt.push(`sshPort=${opts.sshPort}`);
  }
  if (opts.cliPath?.trim()) {
    txt.push(`cliPath=${opts.cliPath.trim()}`);
  }

  const records: string[] = [];

  records.push(`$ORIGIN ${domain}`);
  records.push(`$TTL 60`);
  const soaLine = `@ IN SOA ns1 hostmaster ${opts.serial} 7200 3600 1209600 60`;
  records.push(soaLine);
  records.push(`@ IN NS ns1`);
  records.push(`ns1 IN A ${opts.tailnetIPv4}`);
  records.push(`${hostLabel} IN A ${opts.tailnetIPv4}`);
  if (opts.tailnetIPv6) {
    records.push(`${hostLabel} IN AAAA ${opts.tailnetIPv6}`);
  }

  records.push(`_openclaw-gw._tcp IN PTR ${instanceLabel}._openclaw-gw._tcp`);
  records.push(`${instanceLabel}._openclaw-gw._tcp IN SRV 0 0 ${opts.gatewayPort} ${hostLabel}`);
  records.push(`${instanceLabel}._openclaw-gw._tcp IN TXT ${txt.map(txtQuote).join(" ")}`);

  const contentBody = `${records.join("\n")}\n`;
  const hashBody = `${records
    .map((line) =>
      line === soaLine ? `@ IN SOA ns1 hostmaster SERIAL 7200 3600 1209600 60` : line,
    )
    .join("\n")}\n`;
  const contentHash = computeContentHash(hashBody);

  return `; openclaw-content-hash: ${contentHash}\n${contentBody}`;
}

export function renderWideAreaGatewayZoneText(
  opts: WideAreaGatewayZoneOpts & { serial: number },
): string {
  return renderZone(opts);
}

export async function writeWideAreaGatewayZone(
  opts: WideAreaGatewayZoneOpts,
): Promise<{ zonePath: string; changed: boolean }> {
  const domain = normalizeWideAreaDomain(opts.domain);
  if (!domain) {
    throw new Error("wide-area discovery domain is required");
  }
  const zonePath = getWideAreaZonePath(domain);
  await ensureDir(path.dirname(zonePath));

  const existing = (() => {
    try {
      return fs.readFileSync(zonePath, "utf-8");
    } catch {
      return null;
    }
  })();

  const nextNoSerial = renderWideAreaGatewayZoneText({ ...opts, serial: 0 });
  const nextHash = extractContentHash(nextNoSerial);
  const existingHash = existing ? extractContentHash(existing) : null;

  if (existing && nextHash && existingHash === nextHash) {
    return { zonePath, changed: false };
  }

  const existingSerial = existing ? extractSerial(existing) : null;
  const serial = nextSerial(existingSerial, new Date());
  const next = renderWideAreaGatewayZoneText({ ...opts, serial });
  fs.writeFileSync(zonePath, next, "utf-8");
  return { zonePath, changed: true };
}
