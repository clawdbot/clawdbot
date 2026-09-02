import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { LiveSessionModelSelection } from "../../live-model-switch.js";

type AuthProfileSource = "auto" | "user";

export function resolveCompactionLiveModelSelection(params: {
  current: {
    provider: string;
    model: string;
    authProfileId?: string;
    authProfileIdSource: AuthProfileSource;
  };
  requested?: LiveSessionModelSelection;
}): {
  provider: string;
  model: string;
  authProfileId?: string;
  authProfileIdSource: AuthProfileSource;
} {
  const { current, requested } = params;
  if (!requested) {
    return current;
  }
  if (requested.authProfileId) {
    return {
      provider: requested.provider,
      model: requested.model,
      authProfileId: requested.authProfileId,
      authProfileIdSource: requested.authProfileIdSource ?? "auto",
    };
  }
  if (normalizeProviderId(requested.provider) === normalizeProviderId(current.provider)) {
    return { ...current, provider: requested.provider, model: requested.model };
  }
  return {
    provider: requested.provider,
    model: requested.model,
    authProfileIdSource: "auto",
  };
}
