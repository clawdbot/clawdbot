import "./ai-transport-runtime-host.js";
import "@openclaw/ai/transports";

const completionsTesting = globalThis.openclawOpenAICompletionsTransportTestApi;
const responsesTesting = globalThis.openclawOpenAIResponsesTransportTestApi;
if (!completionsTesting || !responsesTesting) {
  throw new Error("OpenAI transport test APIs are unavailable outside test mode");
}

export const testing = {
  ...responsesTesting,
  ...completionsTesting,
};
