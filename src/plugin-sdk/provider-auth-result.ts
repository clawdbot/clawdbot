import { buildAuthProfileId } from "../agents/auth-profiles/identity.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthResult } from "../plugins/types.js";

/** Build the standard auth result payload for OAuth-style provider login flows. */
export function buildOauthProviderAuthResult(params: {
  providerId: string;
  defaultModel: string;
  access: string;
  refresh?: string | null;
  expires?: number | null;
  email?: string | null;
  displayName?: string | null;
  profileName?: string | null;
  profilePrefix?: string;
  credentialExtra?: Record<string, unknown>;
  configPatch?: Partial<OpenClawConfig>;
  notes?: string[];
}): ProviderAuthResult {
  const email = params.email ?? undefined;
  const displayName = params.displayName ?? undefined;
  const defaultModel = normalizeAgentModelRefForConfig(params.defaultModel);
  const profileId = buildAuthProfileId({
    providerId: params.providerId,
    profilePrefix: params.profilePrefix,
    profileName: params.profileName ?? email,
  });

  const credential: AuthProfileCredential = {
    type: "oauth",
    provider: params.providerId,
    access: params.access,
    ...(params.refresh ? { refresh: params.refresh } : {}),
    ...(Number.isFinite(params.expires) ? { expires: params.expires as number } : {}),
    ...(email ? { email } : {}),
    ...(displayName ? { displayName } : {}),
    ...params.credentialExtra,
  } as AuthProfileCredential;

  return {
    profiles: [{ profileId, credential }],
    configPatch:
      params.configPatch ??
      ({
        agents: {
          defaults: {
            models: {
              [defaultModel]: {},
            },
          },
        },
      } as Partial<OpenClawConfig>),
    defaultModel,
    notes: params.notes,
  };
}
