// Qa Lab plugin module implements server runtime behavior.
import { getQaProvider, type QaMockProviderServer, type QaProviderModeInput } from "./index.js";

export async function startQaProviderServer(
  input: QaProviderModeInput,
  params?: { host?: string; port?: number; modelRefs?: readonly string[] },
): Promise<QaMockProviderServer | null> {
  const provider = getQaProvider(input);
  switch (provider.mode) {
    case "mock-openai": {
      const { startQaMockOpenAiServer } = await import("./mock-openai/server.js");
      return await startQaMockOpenAiServer(params);
    }
    case "aimock": {
      const { startQaAimockServer } = await import("./aimock/server.js");
      return await startQaAimockServer(params);
    }
    default:
      return null;
  }
}
