import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { createLazyXaiVideoGenerationProvider as createLazyXaiVideoGenerationProviderCore } from "./lazy-capability-provider-factories.js";

export {
  createLazyXaiImageGenerationProvider,
  createLazyXaiMediaUnderstandingProvider,
} from "./lazy-capability-provider-factories.js";
export function createLazyXaiVideoGenerationProvider() {
  return createLazyXaiVideoGenerationProviderCore({ isProviderApiKeyConfigured });
}
