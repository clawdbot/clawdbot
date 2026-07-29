// Resolves the LAN host OpenClaw should advertise to nearby devices.
import { isRfc1918Ipv4Address } from "@openclaw/net-policy/ip";
import { runCommandWithTimeout as defaultRunCommandWithTimeout } from "../process/exec.js";
import {
  listExternalInterfaceAddresses,
  safeNetworkInterfaces,
  type NetworkInterfacesSnapshot,
} from "./network-interfaces.js";

const DEFAULT_ROUTE_HINT_TIMEOUT_MS = 3_000;
const DEFAULT_ROUTE_HINT_OUTPUT_BYTES = 16 * 1024;
const WINDOWS_DEFAULT_ROUTE_COMMAND =
  "Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | " +
  "Select-Object -Property InterfaceAlias,InterfaceIndex,NextHop,RouteMetric,InterfaceMetric,DestinationPrefix | " +
  "ConvertTo-Json -Compress";

type AdvertisedLanHostCandidate = {
  interfaceName: string;
  address: string;
  order: number;
};

type AdvertisedLanRouteHint = {
  interfaceName: string;
};

type AdvertisedLanHostCommandResult = {
  code: number | null;
  stdout: string;
  stderr?: string;
};

type AdvertisedLanHostCommandRunner = (
  argv: string[],
  opts: { timeoutMs: number; maxOutputBytes?: number },
) => Promise<AdvertisedLanHostCommandResult>;

type ResolveAdvertisedLanHostOptions = {
  networkInterfaces?: () => NetworkInterfacesSnapshot;
  runCommandWithTimeout?: AdvertisedLanHostCommandRunner;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
};

type WindowsRouteRow = {
  InterfaceAlias?: unknown;
  InterfaceMetric?: unknown;
  RouteMetric?: unknown;
};

type RankedWindowsRouteRow = {
  interfaceName: string;
  effectiveMetric: number;
  routeMetric: number;
  interfaceMetric: number;
  order: number;
};

function normalizeInterfaceName(name: unknown): string {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

function normalizeMetric(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function listAdvertisedLanHostCandidates(
  snapshot: NetworkInterfacesSnapshot | undefined,
): AdvertisedLanHostCandidate[] {
  return listExternalInterfaceAddresses(snapshot, "IPv4")
    .filter((entry) => isRfc1918Ipv4Address(entry.address))
    .map((entry, order) => ({
      interfaceName: entry.name,
      address: entry.address,
      order,
    }));
}

function selectAdvertisedLanHost(
  candidates: AdvertisedLanHostCandidate[],
  routeHints: AdvertisedLanRouteHint[] = [],
): string | null {
  if (candidates.length === 0) {
    return null;
  }

  for (const hint of routeHints) {
    const hintedName = normalizeInterfaceName(hint.interfaceName);
    if (!hintedName) {
      continue;
    }
    const routed = candidates.find(
      (candidate) => normalizeInterfaceName(candidate.interfaceName) === hintedName,
    );
    if (routed) {
      return routed.address;
    }
  }

  return candidates[0]?.address ?? null;
}

function parseWindowsDefaultRouteHints(stdout: string): AdvertisedLanRouteHint[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const rankedRows: RankedWindowsRouteRow[] = [];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const [order, row] of rows.entries()) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const route = row as WindowsRouteRow;
    const interfaceName = normalizeInterfaceName(route.InterfaceAlias);
    if (interfaceName) {
      const routeMetric = normalizeMetric(route.RouteMetric);
      const interfaceMetric = normalizeMetric(route.InterfaceMetric);
      rankedRows.push({
        interfaceName,
        effectiveMetric: routeMetric + interfaceMetric,
        routeMetric,
        interfaceMetric,
        order,
      });
    }
  }
  rankedRows.sort(
    (a, b) =>
      a.effectiveMetric - b.effectiveMetric ||
      a.routeMetric - b.routeMetric ||
      a.interfaceMetric - b.interfaceMetric ||
      a.order - b.order,
  );
  return rankedRows.map((row) => ({ interfaceName: row.interfaceName }));
}

function parseMacOsDefaultRouteHints(stdout: string): AdvertisedLanRouteHint[] {
  const match = /^\s*interface:\s*(\S+)/m.exec(stdout);
  return match?.[1] ? [{ interfaceName: match[1] }] : [];
}

function parseLinuxDefaultRouteHints(stdout: string): AdvertisedLanRouteHint[] {
  const hints: AdvertisedLanRouteHint[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("default ")) {
      continue;
    }
    const match = /\bdev\s+(\S+)/.exec(line);
    if (match?.[1]) {
      hints.push({ interfaceName: match[1] });
    }
  }
  return hints;
}

async function runRouteHintCommand(
  runCommandWithTimeout: AdvertisedLanHostCommandRunner,
  argv: string[],
  timeoutMs: number,
): Promise<string | null> {
  try {
    const result = await runCommandWithTimeout(argv, {
      timeoutMs,
      maxOutputBytes: DEFAULT_ROUTE_HINT_OUTPUT_BYTES,
    });
    return result.code === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

async function resolveDefaultRouteHints(params: {
  platform: NodeJS.Platform;
  runCommandWithTimeout: AdvertisedLanHostCommandRunner;
  timeoutMs: number;
}): Promise<AdvertisedLanRouteHint[]> {
  if (params.platform === "win32") {
    const stdout = await runRouteHintCommand(
      params.runCommandWithTimeout,
      [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WINDOWS_DEFAULT_ROUTE_COMMAND,
      ],
      params.timeoutMs,
    );
    return stdout ? parseWindowsDefaultRouteHints(stdout) : [];
  }

  if (params.platform === "darwin") {
    const stdout = await runRouteHintCommand(
      params.runCommandWithTimeout,
      ["route", "-n", "get", "default"],
      params.timeoutMs,
    );
    return stdout ? parseMacOsDefaultRouteHints(stdout) : [];
  }

  if (params.platform === "linux") {
    const stdout = await runRouteHintCommand(
      params.runCommandWithTimeout,
      ["ip", "-4", "route", "show", "default"],
      params.timeoutMs,
    );
    return stdout ? parseLinuxDefaultRouteHints(stdout) : [];
  }

  return [];
}

export async function resolveAdvertisedLanHost(
  options: ResolveAdvertisedLanHostOptions = {},
): Promise<string | null> {
  const candidates = listAdvertisedLanHostCandidates(
    safeNetworkInterfaces(options.networkInterfaces),
  );
  if (candidates.length === 0) {
    return null;
  }

  const routeHints = await resolveDefaultRouteHints({
    platform: options.platform ?? process.platform,
    runCommandWithTimeout: options.runCommandWithTimeout ?? defaultRunCommandWithTimeout,
    timeoutMs: options.timeoutMs ?? DEFAULT_ROUTE_HINT_TIMEOUT_MS,
  });
  return selectAdvertisedLanHost(candidates, routeHints);
}
