import { runCommandWithTimeout } from "../process/exec.js";
import { WIDE_AREA_DISCOVERY_DOMAIN } from "./widearea-dns.js";

export type GatewayBonjourBeacon = {
  instanceName: string;
  domain?: string;
  displayName?: string;
  host?: string;
  port?: number;
  lanHost?: string;
  tailnetDns?: string;
  gatewayPort?: number;
  sshPort?: number;
  gatewayTls?: boolean;
  gatewayTlsFingerprintSha256?: string;
  cliPath?: string;
  role?: string;
  transport?: string;
  txt?: Record<string, string>;
};

export type GatewayBonjourDiscoverOpts = {
  timeoutMs?: number;
  domains?: string[];
  platform?: NodeJS.Platform;
  run?: typeof runCommandWithTimeout;
};

const DEFAULT_TIMEOUT_MS = 2000;

const DEFAULT_DOMAINS = ["local.", WIDE_AREA_DISCOVERY_DOMAIN] as const;

function decodeDnsSdEscapes(value: string): string {
  let decoded = false;
  const bytes: number[] = [];
  let pending = "";

  const flush = () => {
    if (!pending) return;
    bytes.push(...Buffer.from(pending, "utf8"));
    pending = "";
  };

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] ?? "";
    if (ch === "\\" && i + 3 < value.length) {
      const escaped = value.slice(i + 1, i + 4);
      if (/^[0-9]{3}$/.test(escaped)) {
        const byte = Number.parseInt(escaped, 10);
        if (!Number.isFinite(byte) || byte < 0 || byte > 255) {
          pending += ch;
          continue;
        }
        flush();
        bytes.push(byte);
        decoded = true;
        i += 3;
        continue;
      }
    }
    pending += ch;
  }

  if (!decoded) return value;
  flush();
  return Buffer.from(bytes).toString("utf8");
}

function isTailnetIPv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number.parseInt(p, 10));
  if (octets.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  // Tailscale IPv4 range: 100.64.0.0/10
  const [a, b] = octets;
  return a === 100 && b >= 64 && b <= 127;
}

function parseDigShortLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function parseDigTxt(stdout: string): string[] {
  // dig +short TXT prints one or more lines of quoted strings:
  // "k=v" "k2=v2"
  const tokens: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const matches = Array.from(line.matchAll(/"([^"]*)"/g), (m) => m[1] ?? "");
    for (const m of matches) {
      const unescaped = m.replaceAll("\\\\", "\\").replaceAll('\\"', '"').replaceAll("\\n", "\n");
      tokens.push(unescaped);
    }
  }
  return tokens;
}

function parseDigSrv(stdout: string): { host: string; port: number } | null {
  // dig +short SRV: "0 0 18790 host.domain."
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const parts = line.split(/\s+/).filter(Boolean);
  if (parts.length < 4) return null;
  const port = Number.parseInt(parts[2] ?? "", 10);
  const hostRaw = parts[3] ?? "";
  if (!Number.isFinite(port) || port <= 0) return null;
  const host = hostRaw.replace(/\.$/, "");
  if (!host) return null;
  return { host, port };
}

function parseTailscaleStatusIPv4s(stdout: string): string[] {
  const parsed = stdout ? (JSON.parse(stdout) as Record<string, unknown>) : {};
  const out: string[] = [];

  const addIps = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const ips = (value as { TailscaleIPs?: unknown }).TailscaleIPs;
    if (!Array.isArray(ips)) return;
    for (const ip of ips) {
      if (typeof ip !== "string") continue;
      const trimmed = ip.trim();
      if (trimmed && isTailnetIPv4(trimmed)) out.push(trimmed);
    }
  };

  addIps((parsed as { Self?: unknown }).Self);

  const peerObj = (parsed as { Peer?: unknown }).Peer;
  if (peerObj && typeof peerObj === "object") {
    for (const peer of Object.values(peerObj as Record<string, unknown>)) {
      addIps(peer);
    }
  }

  return [...new Set(out)];
}

function parseIntOrNull(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseTxtTokens(tokens: string[]): Record<string, string> {
  const txt: Record<string, string> = {};
  for (const token of tokens) {
    const idx = token.indexOf("=");
    if (idx <= 0) continue;
    const key = token.slice(0, idx).trim();
    const value = decodeDnsSdEscapes(token.slice(idx + 1).trim());
    if (!key) continue;
    txt[key] = value;
  }
  return txt;
}

function parseDnsSdBrowse(stdout: string): string[] {
  const instances = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line || !line.includes("_moltbot-gw._tcp")) continue;
    if (!line.includes("Add")) continue;
    const match = line.match(/_moltbot-gw\._tcp\.?\s+(.+)$/);
    if (match?.[1]) {
      instances.add(decodeDnsSdEscapes(match[1].trim()));
    }
  }
  return Array.from(instances.values());
}

function parseDnsSdResolve(stdout: string, instanceName: string): GatewayBonjourBeacon | null {
  const decodedInstanceName = decodeDnsSdEscapes(instanceName);
  const beacon: GatewayBonjourBeacon = { instanceName: decodedInstanceName };
  let txt: Record<string, string> = {};
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    if (line.includes("can be reached at")) {
      const match = line.match(/can be reached at\s+([^\s:]+):(\d+)/i);
      if (match?.[1]) {
        beacon.host = match[1].replace(/\.$/, "");
      }
      if (match?.[2]) {
        beacon.port = parseIntOrNull(match[2]);
      }
      continue;
    }

    if (line.startsWith("txt") || line.includes("txtvers=")) {
      const tokens = line.split(/\s+/).filter(Boolean);
      txt = parseTxtTokens(tokens);
    }
  }

  beacon.txt = Object.keys(txt).length ? txt : undefined;
  if (txt.displayName) beacon.displayName = decodeDnsSdEscapes(txt.displayName);
  if (txt.lanHost) beacon.lanHost = txt.lanHost;
  if (txt.tailnetDns) beacon.tailnetDns = txt.tailnetDns;
  if (txt.cliPath) beacon.cliPath = txt.cliPath;
  beacon.gatewayPort = parseIntOrNull(txt.gatewayPort);
  beacon.sshPort = parseIntOrNull(txt.sshPort);
  if (txt.gatewayTls) {
    const raw = txt.gatewayTls.trim().toLowerCase();
    beacon.gatewayTls = raw === "1" || raw === "true" || raw === "yes";
  }
  if (txt.gatewayTlsSha256) beacon.gatewayTlsFingerprintSha256 = txt.gatewayTlsSha256;
  if (txt.role) beacon.role = txt.role;
  if (txt.transport) beacon.transport = txt.transport;

  if (!beacon.displayName) beacon.displayName = decodedInstanceName;
  return beacon;
}

async function discoverViaDnsSd(
  domain: string,
  timeoutMs: number,
  run: typeof runCommandWithTimeout,
): Promise<GatewayBonjourBeacon[]> {
  const browse = await run(["dns-sd", "-B", "_moltbot-gw._tcp", domain], {
    timeoutMs,
  });
  const instances = parseDnsSdBrowse(browse.stdout);
  const results: GatewayBonjourBeacon[] = [];
  for (const instance of instances) {
    const resolved = await run(["dns-sd", "-L", instance, "_moltbot-gw._tcp", domain], {
      timeoutMs,
    });
    const parsed = parseDnsSdResolve(resolved.stdout, instance);
    if (parsed) results.push({ ...parsed, domain });
  }
  return results;
}

async function discoverWideAreaViaTailnetDns(
  domain: string,
  timeoutMs: number,
  run: typeof runCommandWithTimeout,
): Promise<GatewayBonjourBeacon[]> {
  if (domain !== WIDE_AREA_DISCOVERY_DOMAIN) return [];
  const startedAt = Date.now();
  const remainingMs = () => timeoutMs - (Date.now() - startedAt);

  const tailscaleCandidates = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
  let ips: string[] = [];
  for (const candidate of tailscaleCandidates) {
    try {
      const res = await run([candidate, "status", "--json"], {
        timeoutMs: Math.max(1, Math.min(700, remainingMs())),
      });
      ips = parseTailscaleStatusIPv4s(res.stdout);
      if (ips.length > 0) break;
    } catch {
      // ignore
    }
  }
  if (ips.length === 0) return [];
  if (remainingMs() <= 0) return [];

  // Keep scans bounded: this is a fallback and should not block long.
  ips = ips.slice(0, 40);

  const probeName = `_moltbot-gw._tcp.${domain.replace(/\.$/, "")}`;

  const concurrency = 6;
  let nextIndex = 0;
  let nameserver: string | null = null;
  let ptrs: string[] = [];

  const worker = async () => {
    while (nameserver === null) {
      const budget = remainingMs();
      if (budget <= 0) return;
      const i = nextIndex;
      nextIndex += 1;
      if (i >= ips.length) return;
      const ip = ips[i] ?? "";
      if (!ip) continue;
      try {
        const probe = await run(
          ["dig", "+short", "+time=1", "+tries=1", `@${ip}`, probeName, "PTR"],
          { timeoutMs: Math.max(1, Math.min(250, budget)) },
        );
        const lines = parseDigShortLines(probe.stdout);
        if (lines.length === 0) continue;
        nameserver = ip;
        ptrs = lines;
        return;
      } catch {
        // ignore
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, ips.length) }, () => worker()));

  if (!nameserver || ptrs.length === 0) return [];
  if (remainingMs() <= 0) return [];
  const nameserverArg = `@${String(nameserver)}`;

  const results: GatewayBonjourBeacon[] = [];
  for (const ptr of ptrs) {
    const budget = remainingMs();
    if (budget <= 0) break;
    const ptrName = ptr.trim().replace(/\.$/, "");
    if (!ptrName) continue;
    const instanceName = ptrName.replace(/\.?_moltbot-gw\._tcp\..*$/, "");

    const srv = await run(["dig", "+short", "+time=1", "+tries=1", nameserverArg, ptrName, "SRV"], {
      timeoutMs: Math.max(1, Math.min(350, budget)),
    }).catch(() => null);
    const srvParsed = srv ? parseDigSrv(srv.stdout) : null;
    if (!srvParsed) continue;

    const txtBudget = remainingMs();
    if (txtBudget <= 0) {
      results.push({
        instanceName: instanceName || ptrName,
        displayName: instanceName || ptrName,
        domain,
        host: srvParsed.host,
        port: srvParsed.port,
      });
      continue;
    }

    const txt = await run(["dig", "+short", "+time=1", "+tries=1", nameserverArg, ptrName, "TXT"], {
      timeoutMs: Math.max(1, Math.min(350, txtBudget)),
    }).catch(() => null);
    const txtTokens = txt ? parseDigTxt(txt.stdout) : [];
    const txtMap = txtTokens.length > 0 ? parseTxtTokens(txtTokens) : {};

    const beacon: GatewayBonjourBeacon = {
      instanceName: instanceName || ptrName,
      displayName: txtMap.displayName || instanceName || ptrName,
      domain,
      host: srvParsed.host,
      port: srvParsed.port,
      txt: Object.keys(txtMap).length ? txtMap : undefined,
      gatewayPort: parseIntOrNull(txtMap.gatewayPort),
      sshPort: parseIntOrNull(txtMap.sshPort),
      tailnetDns: txtMap.tailnetDns || undefined,
      cliPath: txtMap.cliPath || undefined,
    };
    if (txtMap.gatewayTls) {
      const raw = txtMap.gatewayTls.trim().toLowerCase();
      beacon.gatewayTls = raw === "1" || raw === "true" || raw === "yes";
    }
    if (txtMap.gatewayTlsSha256) beacon.gatewayTlsFingerprintSha256 = txtMap.gatewayTlsSha256;
    if (txtMap.role) beacon.role = txtMap.role;
    if (txtMap.transport) beacon.transport = txtMap.transport;

    results.push(beacon);
  }

  return results;
}

function parseAvahiBrowse(stdout: string): GatewayBonjourBeacon[] {
  const results: GatewayBonjourBeacon[] = [];
  let current: GatewayBonjourBeacon | null = null;

  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith("=") && line.includes("_moltbot-gw._tcp")) {
      if (current) results.push(current);
      const marker = " _moltbot-gw._tcp";
      const idx = line.indexOf(marker);
      const left = idx >= 0 ? line.slice(0, idx).trim() : line;
      const parts = left.split(/\s+/);
      const instanceName = parts.length > 3 ? parts.slice(3).join(" ") : left;
      current = {
        instanceName,
        displayName: instanceName,
      };
      continue;
    }

    if (!current) continue;

    const trimmed = line.trim();
    if (trimmed.startsWith("hostname =")) {
      const match = trimmed.match(/hostname\s*=\s*\[([^\]]+)\]/);
      if (match?.[1]) current.host = match[1];
      continue;
    }

    if (trimmed.startsWith("port =")) {
      const match = trimmed.match(/port\s*=\s*\[(\d+)\]/);
      if (match?.[1]) current.port = parseIntOrNull(match[1]);
      continue;
    }

    if (trimmed.startsWith("txt =")) {
      const tokens = Array.from(trimmed.matchAll(/"([^"]*)"/g), (m) => m[1]);
      const txt = parseTxtTokens(tokens);
      current.txt = Object.keys(txt).length ? txt : undefined;
      if (txt.displayName) current.displayName = txt.displayName;
      if (txt.lanHost) current.lanHost = txt.lanHost;
      if (txt.tailnetDns) current.tailnetDns = txt.tailnetDns;
      if (txt.cliPath) current.cliPath = txt.cliPath;
      current.gatewayPort = parseIntOrNull(txt.gatewayPort);
      current.sshPort = parseIntOrNull(txt.sshPort);
      if (txt.gatewayTls) {
        const raw = txt.gatewayTls.trim().toLowerCase();
        current.gatewayTls = raw === "1" || raw === "true" || raw === "yes";
      }
      if (txt.gatewayTlsSha256) current.gatewayTlsFingerprintSha256 = txt.gatewayTlsSha256;
      if (txt.role) current.role = txt.role;
      if (txt.transport) current.transport = txt.transport;
    }
  }

  if (current) results.push(current);
  return results;
}

async function discoverViaAvahi(
  domain: string,
  timeoutMs: number,
  run: typeof runCommandWithTimeout,
): Promise<GatewayBonjourBeacon[]> {
  const args = ["avahi-browse", "-rt", "_moltbot-gw._tcp"];
  if (domain && domain !== "local.") {
    // avahi-browse wants a plain domain (no trailing dot)
    args.push("-d", domain.replace(/\.$/, ""));
  }
  const browse = await run(args, { timeoutMs });
  return parseAvahiBrowse(browse.stdout).map((beacon) => ({
    ...beacon,
    domain,
  }));
}

export async function discoverGatewayBeacons(
  opts: GatewayBonjourDiscoverOpts = {},
): Promise<GatewayBonjourBeacon[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runCommandWithTimeout;
  const domainsRaw = Array.isArray(opts.domains) ? opts.domains : [];
  const domains = (domainsRaw.length > 0 ? domainsRaw : [...DEFAULT_DOMAINS])
    .map((d) => String(d).trim())
    .filter(Boolean)
    .map((d) => (d.endsWith(".") ? d : `${d}.`));

  try {
    if (platform === "darwin") {
      const perDomain = await Promise.allSettled(
        domains.map(async (domain) => await discoverViaDnsSd(domain, timeoutMs, run)),
      );
      const discovered = perDomain.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

      const wantsWideArea = domains.includes(WIDE_AREA_DISCOVERY_DOMAIN);
      const hasWideArea = discovered.some((b) => b.domain === WIDE_AREA_DISCOVERY_DOMAIN);

      if (wantsWideArea && !hasWideArea) {
        const fallback = await discoverWideAreaViaTailnetDns(
          WIDE_AREA_DISCOVERY_DOMAIN,
          timeoutMs,
          run,
        ).catch(() => []);
        return [...discovered, ...fallback];
      }

      return discovered;
    }
    if (platform === "linux") {
      const perDomain = await Promise.allSettled(
        domains.map(async (domain) => await discoverViaAvahi(domain, timeoutMs, run)),
      );
      return perDomain.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    }
  } catch {
    return [];
  }
  return [];
}
