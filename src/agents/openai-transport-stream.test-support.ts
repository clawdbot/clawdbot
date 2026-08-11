import "./ai-transport-runtime-host.js";
import "@openclaw/ai/transports";

const completionsTesting = globalThis.openclawOpenAICompletionsTransportTestApi;
const responsesTesting = globalThis.openclawOpenAIResponsesTransportTestApi;
if (!completionsTesting || !responsesTesting) {
  throw new Error("OpenAI transport test APIs are unavailable outside test mode");
}

type OpenAICompletionsTransportTestApi = NonNullable<
  typeof globalThis.openclawOpenAICompletionsTransportTestApi
>;
type OpenAIResponsesTransportTestApi = NonNullable<
  typeof globalThis.openclawOpenAIResponsesTransportTestApi
>;
type OpenAITransportTestApi = Omit<
  OpenAIResponsesTransportTestApi,
  keyof OpenAICompletionsTransportTestApi
> &
  OpenAICompletionsTransportTestApi;

// Keep declaration emit on the public test-API names instead of transport internals.
export const testing: OpenAITransportTestApi = {
  ...responsesTesting,
  ...completionsTesting,
};
