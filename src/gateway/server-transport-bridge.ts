import type { createGatewayHttpTransport } from "./server-runtime-state.js";

export type GatewayHttpTransport = Awaited<ReturnType<typeof createGatewayHttpTransport>>;

/** Late-bound transport facts consumed by the socket-free Gateway kernel. */
export function createGatewayTransportBridge() {
  let current: GatewayHttpTransport | undefined;

  return {
    attach: (transport: GatewayHttpTransport) => {
      current = transport;
    },
    current: () => current,
    getPortalService: () => current?.portalService,
    getWorkerIngressEndpoint: () => current?.getWorkerIngressEndpoint(),
    getTailscaleIngressEndpoint: () => current?.getTailscaleIngressEndpoint(),
    getMcpAppSandboxPort: () => current?.getMcpAppSandboxPort(),
    ensureSandboxHostPort: async () => {
      if (!current) {
        throw new Error("Gateway listener must start before the sandbox host");
      }
      return await current.ensureSandboxHostPort();
    },
  };
}
