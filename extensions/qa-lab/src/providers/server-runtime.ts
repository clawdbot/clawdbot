import { getQaProvider, type QaMockProviderServer, type QaProviderModeInput } from "./index.js";

type QaProviderServerParams = {
  host: string;
  port: number;
};

async function startMockOpenAiProviderServer(params: QaProviderServerParams) {
  const { startQaMockOpenAiServer } = await import("./mock-openai/server.js");
  return await startQaMockOpenAiServer(params);
}

async function startAimockProviderServer(params: QaProviderServerParams) {
  const { startQaAimockServer } = await import("./aimock/server.js");
  return await startQaAimockServer(params);
}

export async function startQaProviderServer(
  input: QaProviderModeInput,
  params?: { host?: string; port?: number },
): Promise<QaMockProviderServer | null> {
  const provider = getQaProvider(input);
  const serverParams = {
    host: params?.host ?? "127.0.0.1",
    port: params?.port ?? 0,
  };
  switch (provider.mode) {
    case "mock-openai":
      return await startMockOpenAiProviderServer(serverParams);
    case "aimock":
      return await startAimockProviderServer(serverParams);
    case "live-frontier":
    default:
      return null;
  }
}
