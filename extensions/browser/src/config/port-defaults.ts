/**
 * Browser-specific default ports and derived CDP ranges.
 */
type PortRange = { start: number; end: number };

const DEFAULT_BROWSER_CDP_PORT_RANGE_START = 18800;
const DEFAULT_BROWSER_CDP_PORT_RANGE_END = 18899;
const DEFAULT_BROWSER_CDP_PORT_RANGE_SPAN =
  DEFAULT_BROWSER_CDP_PORT_RANGE_END - DEFAULT_BROWSER_CDP_PORT_RANGE_START;

/** Default loopback port for the Browser control server. */
export const DEFAULT_BROWSER_CONTROL_PORT = 18791;

function isValidPort(port: number): boolean {
  return Number.isFinite(port) && port > 0 && port <= 65535;
}

function clampPort(port: number, fallback: number): number {
  return isValidPort(port) ? port : fallback;
}

function derivePort(base: number, offset: number, fallback: number): number {
  return clampPort(base + offset, fallback);
}

/** Derives the Browser control port from the gateway port. */
export function deriveDefaultBrowserControlPort(gatewayPort: number): number {
  return derivePort(gatewayPort, 2, DEFAULT_BROWSER_CONTROL_PORT);
}

/** Derives the managed Chrome CDP port range from the Browser control port. */
export function deriveDefaultBrowserCdpPortRange(browserControlPort: number): PortRange {
  const start = derivePort(browserControlPort, 9, DEFAULT_BROWSER_CDP_PORT_RANGE_START);
  const end = start + DEFAULT_BROWSER_CDP_PORT_RANGE_SPAN;
  if (end <= 65535) {
    return { start, end };
  }
  return {
    start: DEFAULT_BROWSER_CDP_PORT_RANGE_START,
    end: DEFAULT_BROWSER_CDP_PORT_RANGE_END,
  };
}
