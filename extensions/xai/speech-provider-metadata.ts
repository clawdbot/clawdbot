import { isProviderAuthProfileConfigured } from "openclaw/plugin-sdk/provider-auth";
import { createXaiSpeechProviderMetadata as createXaiSpeechProviderMetadataCore } from "./speech-provider-metadata-factory.js";
export * from "./speech-provider-metadata-factory.js";

export function createXaiSpeechProviderMetadata() {
  return createXaiSpeechProviderMetadataCore({ isProviderAuthProfileConfigured });
}
