/** Collects text-to-speech secret refs from runtime config. */
import {
  collectRuntimeSecretInputAssignment,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

function collectProviderApiKeyAssignment(params: {
  providerId: string;
  providerConfig: Record<string, unknown>;
  pathPrefix: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active?: boolean;
  inactiveReason?: string;
}): void {
  collectRuntimeSecretInputAssignment({
    value: params.providerConfig.apiKey,
    path: `${params.pathPrefix}.providers.${params.providerId}.apiKey`,
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: params.active,
    inactiveReason: params.inactiveReason,
    owner: {
      ownerKind: "capability",
      ownerId: "tts",
      requiredForGateway: false,
      disposition: "isolate",
    },
    apply: (value) => {
      params.providerConfig.apiKey = value;
    },
  });
}

/** Collects provider API key SecretRefs from a TTS config block. */
export function collectTtsApiKeyAssignments(params: {
  tts: Record<string, unknown>;
  pathPrefix: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active?: boolean;
  inactiveReason?: string;
}): void {
  const providers = params.tts.providers;
  if (isRecord(providers)) {
    for (const [providerId, providerConfig] of Object.entries(providers)) {
      if (!isRecord(providerConfig)) {
        continue;
      }
      collectProviderApiKeyAssignment({
        providerId,
        providerConfig,
        pathPrefix: params.pathPrefix,
        defaults: params.defaults,
        context: params.context,
        active: params.active,
        inactiveReason: params.inactiveReason,
      });
    }
  }
}
