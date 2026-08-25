import type {
  GatewayClient,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

export function createWizardTestClient(caps: string[] = []): GatewayClient {
  // SAFETY: Wizard handler tests exercise only caller identity and negotiated capabilities.
  return {
    connId: "wizard-test-connection",
    connect: { caps },
  } as GatewayClient;
}

export function bindWizardTestClient(handlers: GatewayRequestHandlers): GatewayRequestHandlers {
  const defaultClient = createWizardTestClient();
  return new Proxy(handlers, {
    get(target, property, receiver) {
      const handler = Reflect.get(target, property, receiver);
      return typeof handler === "function"
        ? (options: GatewayRequestHandlerOptions) =>
            handler({ ...options, client: options.client ?? defaultClient })
        : handler;
    },
  });
}
