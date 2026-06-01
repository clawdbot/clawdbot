type StartGatewayServer = typeof import("./server.js").startGatewayServer;
type GatewayServerOptions = NonNullable<Parameters<StartGatewayServer>[1]>;

export async function startOpenAiCompatGatewayServer(options: {
  startGatewayServer: StartGatewayServer;
  port: number;
  auth: GatewayServerOptions["auth"];
  openAiChatCompletionsEnabled?: boolean;
}) {
  return await options.startGatewayServer(options.port, {
    host: "127.0.0.1",
    auth: options.auth,
    controlUiEnabled: false,
    openAiChatCompletionsEnabled: options.openAiChatCompletionsEnabled ?? false,
  });
}
