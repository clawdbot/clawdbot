import { createGatewayHttpServer } from "../server-http.js";
import { createNodeWorkspaceTransferHttpCallback } from "./node-workspace-transfer-http.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";

export async function startNodeWorkspaceTransferTestServer(service: NodeWorkspaceTransferService) {
  const server = createGatewayHttpServer({
    clients: new Set(),
    controlUiEnabled: false,
    controlUiBasePath: "",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: async () => false,
    resolvedAuth: { mode: "none", allowTailscale: false },
    getRuntimeConfig: () => ({}),
    handleNodeWorkspaceTransferRequest: createNodeWorkspaceTransferHttpCallback(service),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("workspace transfer test server did not bind");
  }
  return {
    gatewayUrl: `ws://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
