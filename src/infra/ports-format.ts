// Formats port probe results for diagnostics and CLI output.
import net from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { formatCliCommand } from "../cli/command-format.js";
import type { PortListener, PortListenerKind, PortUsage } from "./ports-types.js";

/** Classifies a listener as OpenClaw Gateway, SSH tunnel, known non-gateway, or unknown. */
export function classifyPortListener(listener: PortListener, _port: number): PortListenerKind {
  const raw = normalizeLowercaseStringOrEmpty(
    `${listener.commandLine ?? ""} ${listener.command ?? ""}`,
  );
  if (raw.includes("openclaw")) {
    return "gateway";
  }
  const command = normalizeLowercaseStringOrEmpty(listener.command ?? "");
  const commandLine = normalizeLowercaseStringOrEmpty(listener.commandLine ?? "");
  const hasSshCommand = /(?:^|[/\\])ssh(?:\.exe)?$/.test(command);
  const hasSshExecutable =
    hasSshCommand ||
    /(?:^|[\s"'])(?:(?:"[^"]*[/\\])|(?:'[^']*[/\\])|(?:\S*[/\\]))?ssh(?:\.exe)?(?:[\s"']|$)/.test(
      commandLine,
    );
  if (hasSshCommand) {
    return "ssh";
  }
  if (hasSshExecutable) {
    // The probe row already proves this process owns the queried port. Exact
    // ssh executables may get their forwards from ssh_config or host aliases.
    return "ssh";
  }
  if (
    command === "sshd" ||
    /(?:^|[/\\])sshd(?:\.exe)?$/.test(command) ||
    /(?:^|[/\\])[^/\\\s]*ssh[^/\\\s]*(?:\.exe)?$/.test(command)
  ) {
    return "non_gateway";
  }
  if (/(?:^|[/\\\s])[^/\\\s]*ssh[^/\\\s]*(?:\.exe)?(?:[/\\\s"']|$)/.test(commandLine)) {
    return "non_gateway";
  }
  return "unknown";
}

function parseListenerAddress(address: string): { host: string; port: number } | null {
  const trimmed = address.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/^tcp6?\s+/i, "").replace(/\s*\(listen\)\s*$/i, "");
  const bracketMatch = normalized.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketMatch) {
    const port = Number.parseInt(
      expectDefined(bracketMatch[2], "bracket match capture group 2"),
      10,
    );
    return Number.isFinite(port)
      ? { host: normalizeLowercaseStringOrEmpty(bracketMatch[1]), port }
      : null;
  }
  const lastColon = normalized.lastIndexOf(":");
  if (lastColon <= 0 || lastColon >= normalized.length - 1) {
    return null;
  }
  const host = normalizeLowercaseStringOrEmpty(normalized.slice(0, lastColon));
  const portToken = normalized.slice(lastColon + 1).trim();
  if (!/^\d+$/.test(portToken)) {
    return null;
  }
  const port = Number.parseInt(portToken, 10);
  return Number.isFinite(port) ? { host, port } : null;
}

// Dual-stack listener output can include IPv4-mapped IPv6 addresses; keep them
// in the IPv6 family so the benign loopback-pair detection stays conservative.
function classifyLoopbackAddressFamily(host: string): "ipv4" | "ipv6" | null {
  if (host === "127.0.0.1" || host === "localhost") {
    return "ipv4";
  }
  if (host === "::1") {
    return "ipv6";
  }
  if (host.startsWith("::ffff:")) {
    const mapped = host.slice("::ffff:".length);
    return mapped === "127.0.0.1" ? "ipv6" : null;
  }
  return null;
}

function isWildcardAddress(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "*";
}

function isExpectedGatewayBindAddress(host: string): boolean {
  return classifyLoopbackAddressFamily(host) !== null || isWildcardAddress(host);
}

type ParsedGatewayListener = { pid: number; host: string };

function parsePortListeners(
  listeners: PortListener[],
  port: number,
): ParsedGatewayListener[] | null {
  const parsedListeners: ParsedGatewayListener[] = [];
  for (const listener of listeners) {
    const pid = listener.pid;
    if (typeof pid !== "number" || !Number.isFinite(pid) || typeof listener.address !== "string") {
      return null;
    }
    const address = parseListenerAddress(listener.address);
    if (!address || address.port !== port) {
      return null;
    }
    parsedListeners.push({ pid, host: address.host });
  }
  return parsedListeners;
}

function parseGatewayListeners(
  listeners: PortListener[],
  port: number,
): ParsedGatewayListener[] | null {
  if (listeners.some((listener) => classifyPortListener(listener, port) !== "gateway")) {
    return null;
  }
  return parsePortListeners(listeners, port);
}

/** Returns true for one Gateway listener bound to an expected loopback or wildcard address. */
export function isSingleExpectedGatewayListener(listeners: PortListener[], port: number): boolean {
  if (listeners.length !== 1) {
    return false;
  }
  const parsed = parseGatewayListeners(listeners, port);
  return Boolean(parsed?.[0] && isExpectedGatewayBindAddress(parsed[0].host));
}

/** Returns true for one Gateway process represented by separate IPv4 and IPv6 loopback rows. */
export function isDualStackLoopbackGatewayListeners(
  listeners: PortListener[],
  port: number,
): boolean {
  if (listeners.length < 2) {
    return false;
  }
  const parsed = parseGatewayListeners(listeners, port);
  if (!parsed) {
    return false;
  }
  const pids = new Set(parsed.map(({ pid }) => pid));
  const families = new Set(parsed.map(({ host }) => classifyLoopbackAddressFamily(host)));
  return pids.size === 1 && !families.has(null) && families.has("ipv4") && families.has("ipv6");
}

function parsedListenersOwnSpecificIpv4WithLoopback(parsed: ParsedGatewayListener[]): boolean {
  if (new Set(parsed.map(({ pid }) => pid)).size !== 1) {
    return false;
  }
  const hosts = new Set(parsed.map(({ host }) => host));
  const specificHosts = [...hosts].filter(
    (host) => host !== "127.0.0.1" && net.isIP(host) === 4 && !isWildcardAddress(host),
  );
  return hosts.has("127.0.0.1") && specificHosts.length > 0;
}

/** Checks one Gateway PID owns both an exact IPv4 interface and canonical loopback. */
function isSpecificIpv4WithLoopbackGatewayListeners(
  listeners: PortListener[],
  port: number,
): boolean {
  if (listeners.length !== 2) {
    return false;
  }
  const parsed = parseGatewayListeners(listeners, port);
  return Boolean(parsed && parsedListenersOwnSpecificIpv4WithLoopback(parsed));
}

/** Checks one PID owns an expected IPv4 interface and canonical loopback. */
export function isSameProcessSpecificIpv4WithLoopbackListeners(
  listeners: PortListener[],
  port: number,
  expectedSpecificHost: string,
): boolean {
  if (listeners.length !== 2) {
    return false;
  }
  const parsed = parsePortListeners(listeners, port);
  return Boolean(
    parsed &&
    parsedListenersOwnSpecificIpv4WithLoopback(parsed) &&
    parsed.some(({ host }) => host === expectedSpecificHost),
  );
}

/** Returns true when listener rows describe a benign Gateway bind pattern. */
export function isExpectedGatewayListeners(listeners: PortListener[], port: number): boolean {
  return (
    isSingleExpectedGatewayListener(listeners, port) ||
    isDualStackLoopbackGatewayListeners(listeners, port) ||
    isSpecificIpv4WithLoopbackGatewayListeners(listeners, port)
  );
}

/** Builds user-facing remediation hints for processes occupying a port. */
export function buildPortHints(listeners: PortListener[], port: number): string[] {
  if (listeners.length === 0) {
    return [];
  }
  const kinds = new Set(listeners.map((listener) => classifyPortListener(listener, port)));
  const hints: string[] = [];
  const expectedGatewayListeners = isExpectedGatewayListeners(listeners, port);
  if (kinds.has("gateway") && !expectedGatewayListeners) {
    hints.push(
      `Gateway already running locally. Stop it (${formatCliCommand("openclaw gateway stop")}) or use a different port.`,
    );
  }
  if (kinds.has("ssh")) {
    hints.push(
      "SSH tunnel already bound to this port. Close the tunnel or use a different local port in -L.",
    );
  }
  if (kinds.has("unknown") || kinds.has("non_gateway")) {
    hints.push("Another process is listening on this port.");
  }
  if (listeners.length > 1 && !expectedGatewayListeners) {
    hints.push(
      "Multiple listeners detected; ensure only one gateway/tunnel per port unless intentionally running isolated profiles.",
    );
  }
  return hints;
}

/** Formats one listener row for CLI diagnostics. */
export function formatPortListener(listener: PortListener): string {
  const pid = listener.pid ? `pid ${listener.pid}` : "pid ?";
  const user = listener.user ? ` ${listener.user}` : "";
  const command = listener.commandLine || listener.command || "unknown";
  const address = listener.address ? ` (${listener.address})` : "";
  return `${pid}${user}: ${command}${address}`;
}

/** Formats free/busy port diagnostics into CLI output lines. */
export function formatPortDiagnostics(diagnostics: PortUsage): string[] {
  if (diagnostics.status !== "busy") {
    return [`Port ${diagnostics.port} is free.`];
  }
  const lines = [`Port ${diagnostics.port} is already in use.`];
  for (const listener of diagnostics.listeners) {
    lines.push(`- ${formatPortListener(listener)}`);
  }
  for (const hint of diagnostics.hints) {
    lines.push(`- ${hint}`);
  }
  return lines;
}
