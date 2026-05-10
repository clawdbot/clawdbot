import { formatCliCommand } from "../cli/command-format.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { PortListener, PortListenerKind, PortUsage } from "./ports-types.js";

export function classifyPortListener(listener: PortListener, port: number): PortListenerKind {
  const raw = normalizeLowercaseStringOrEmpty(
    `${listener.commandLine ?? ""} ${listener.command ?? ""}`,
  );
  if (raw.includes("openclaw")) {
    return "gateway";
  }
  if (raw.includes("ssh")) {
    const portToken = String(port);
    const tunnelPattern = new RegExp(
      `-(l|r)\\s*${portToken}\\b|-(l|r)${portToken}\\b|:${portToken}\\b`,
    );
    if (!raw || tunnelPattern.test(raw)) {
      return "ssh";
    }
    return "ssh";
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
    const port = Number.parseInt(bracketMatch[2], 10);
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

export function isSingleExpectedGatewayListener(listeners: PortListener[], port: number): boolean {
  if (listeners.length !== 1) {
    return false;
  }
  const [listener] = listeners;
  if (!listener || classifyPortListener(listener, port) !== "gateway") {
    return false;
  }
  const pid = listener.pid;
  if (typeof pid !== "number" || !Number.isFinite(pid)) {
    return false;
  }
  if (typeof listener.address !== "string") {
    return false;
  }
  const parsedAddress = parseListenerAddress(listener.address);
  return Boolean(
    parsedAddress &&
    parsedAddress.port === port &&
    isExpectedGatewayBindAddress(parsedAddress.host),
  );
}

export function isDualStackLoopbackGatewayListeners(
  listeners: PortListener[],
  port: number,
): boolean {
  if (listeners.length < 2) {
    return false;
  }
  const pids = new Set<number>();
  const families = new Set<"ipv4" | "ipv6">();
  for (const listener of listeners) {
    if (classifyPortListener(listener, port) !== "gateway") {
      return false;
    }
    const pid = listener.pid;
    if (typeof pid !== "number" || !Number.isFinite(pid)) {
      return false;
    }
    pids.add(pid);
    if (typeof listener.address !== "string") {
      return false;
    }
    const parsedAddress = parseListenerAddress(listener.address);
    if (!parsedAddress || parsedAddress.port !== port) {
      return false;
    }
    const family = classifyLoopbackAddressFamily(parsedAddress.host);
    if (!family) {
      return false;
    }
    families.add(family);
  }
  return pids.size === 1 && families.has("ipv4") && families.has("ipv6");
}

export function isExpectedGatewayListeners(listeners: PortListener[], port: number): boolean {
  return (
    isSingleExpectedGatewayListener(listeners, port) ||
    isDualStackLoopbackGatewayListeners(listeners, port)
  );
}

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
  if (kinds.has("unknown")) {
    hints.push("Another process is listening on this port.");
  }
  if (listeners.length > 1 && !expectedGatewayListeners) {
    hints.push(
      "Multiple listeners detected; ensure only one gateway/tunnel per port unless intentionally running isolated profiles.",
    );
  }
  return hints;
}

export function formatPortListener(listener: PortListener): string {
  const pid = listener.pid ? `pid ${listener.pid}` : "pid ?";
  const user = listener.user ? ` ${listener.user}` : "";
  const command = listener.commandLine || listener.command || "unknown";
  const address = listener.address ? ` (${listener.address})` : "";
  return `${pid}${user}: ${command}${address}`;
}

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
