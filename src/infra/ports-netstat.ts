import { expectDefined } from "@openclaw/normalization-core";
import { parseStrictPositiveInteger } from "./parse-finite-number.js";
import type { PortListener } from "./ports-types.js";

type WindowsNetstatListener = PortListener & { pid: number; address: string };

function normalizeTcpHost(host: string): string {
  const normalized = host.toLowerCase();
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

function parseTcpPort(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) {
    return null;
  }
  const port = Number(raw);
  return Number.isSafeInteger(port) && port >= 0 && port <= 65_535 ? port : null;
}

export function parseTcpEndpoint(raw: string): { host: string; port: number } | null {
  const endpoint = raw.trim();
  const bracketMatch = endpoint.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketMatch) {
    const port = parseTcpPort(bracketMatch[2]);
    return port === null
      ? null
      : {
          host: normalizeTcpHost(expectDefined(bracketMatch[1], "bracket match capture group 1")),
          port,
        };
  }
  const lastColon = endpoint.lastIndexOf(":");
  if (lastColon <= 0 || lastColon >= endpoint.length - 1) {
    return null;
  }
  const port = parseTcpPort(endpoint.slice(lastColon + 1));
  if (port === null) {
    return null;
  }
  return { host: normalizeTcpHost(endpoint.slice(0, lastColon)), port };
}

function isWildcardEndpoint(raw: string | undefined): boolean {
  const endpoint = raw?.trim();
  if (!endpoint || endpoint === "*:*") {
    return true;
  }
  const parsed = parseTcpEndpoint(endpoint);
  if (!parsed) {
    return false;
  }
  // Windows localizes the TCP state text, so the wildcard peer is the stable
  // listener signal. Be strict here because force paths can kill the returned PID.
  return parsed.port === 0 && ["0.0.0.0", "::", "*"].includes(parsed.host);
}

export function parseWindowsNetstatListeners(
  output: string,
  port: number,
): WindowsNetstatListener[] {
  const listeners: WindowsNetstatListener[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts.length < 5 || parts[0]?.toUpperCase() !== "TCP") {
      continue;
    }
    const localAddress = parts[1];
    const remoteAddress = parts[2];
    if (!localAddress || parseTcpEndpoint(localAddress)?.port !== port) {
      continue;
    }
    if (!isWildcardEndpoint(remoteAddress)) {
      continue;
    }
    const pid = parseStrictPositiveInteger(parts.at(-1));
    if (pid === undefined) {
      continue;
    }
    listeners.push({ pid, address: localAddress });
  }
  return listeners;
}
