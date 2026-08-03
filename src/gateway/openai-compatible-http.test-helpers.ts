/**
 * OpenAI-compatible HTTP gateway startup helper for tests.
 */
type StartGatewayServer = typeof import("./server.js").startGatewayServer;
type GatewayServerOptions = NonNullable<Parameters<StartGatewayServer>[1]>;

/** Starts a local gateway with only the OpenAI-compatible HTTP surface configured. */
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
