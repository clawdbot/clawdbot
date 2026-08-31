import { createHash } from "node:crypto";

export function nodeWorkerGatewayNamespace(gatewayDeviceId: string): string {
  return `gateway-${createHash("sha256").update(gatewayDeviceId).digest("hex").slice(0, 32)}`;
}
