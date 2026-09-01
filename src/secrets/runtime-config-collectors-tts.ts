/** Collects text-to-speech secret refs from runtime config. */
import { appendConfigPathSegment } from "../shared/dot-path.js";
import {
  collectRuntimeSecretInputAssignment,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

type ProviderSecretOwnerId = string | ((providerId: string) => string);

/** Collects provider API key SecretRefs from a TTS-compatible provider config block. */
export function collectTtsApiKeyAssignments(params: {
  tts: Record<string, unknown>;
  pathPrefix: string;
  ownerId?: ProviderSecretOwnerId;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active?: boolean;
  inactiveReason?: string;
}): void {
  const collectProviders = (tts: Record<string, unknown>, pathPrefix: string) => {
    if (!isRecord(tts.providers)) {
      return;
    }
    for (const [providerId, providerConfig] of Object.entries(tts.providers)) {
      if (!isRecord(providerConfig)) {
        continue;
      }
      collectRuntimeSecretInputAssignment({
        value: providerConfig.apiKey,
        path: `${appendConfigPathSegment(`${pathPrefix}.providers`, providerId)}.apiKey`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: params.active,
        inactiveReason: params.inactiveReason,
        owner: {
          ownerKind: "capability",
          ownerId:
            typeof params.ownerId === "function"
              ? params.ownerId(providerId)
              : (params.ownerId ?? "tts"),
          requiredForGateway: false,
          disposition: "isolate",
          // Persona selection may change without reload; retain the complete TTS owner contract.
          contract: params.tts,
        },
        apply: (value) => {
          providerConfig.apiKey = value;
        },
      });
    }
  };
  collectProviders(params.tts, params.pathPrefix);
  if (isRecord(params.tts.personas)) {
    for (const [personaId, persona] of Object.entries(params.tts.personas)) {
      if (isRecord(persona)) {
        collectProviders(
          persona,
          appendConfigPathSegment(`${params.pathPrefix}.personas`, personaId),
        );
      }
    }
  }
}
