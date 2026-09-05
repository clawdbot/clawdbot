import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { buildElevenLabsSpeechProvider as createProvider } from "./speech-provider-factory.js";
export function buildElevenLabsSpeechProvider() {
  return createProvider({ formatErrorMessage });
}
