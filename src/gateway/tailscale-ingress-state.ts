export type GatewayTailscaleIngressMode = "serve" | "funnel";

const effectiveModesByPort = new Map<number, GatewayTailscaleIngressMode>();

/** Record the process-owned Tailscale route that currently targets a Gateway port. */
export function setGatewayTailscaleIngressMode(
  port: number,
  mode: GatewayTailscaleIngressMode,
): void {
  effectiveModesByPort.set(port, mode);
}

export function clearGatewayTailscaleIngressMode(port: number): void {
  effectiveModesByPort.delete(port);
}

export function readGatewayTailscaleIngressMode(
  port: number | undefined,
): GatewayTailscaleIngressMode | undefined {
  return port === undefined ? undefined : effectiveModesByPort.get(port);
}
