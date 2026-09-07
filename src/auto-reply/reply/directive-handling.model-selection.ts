/** Resolves /model directive selections and auth profile overrides. */
import { ensureAuthProfileStore } from "../../agents/auth-profiles.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { ModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveProfileOverride } from "./directive-handling.auth-profile.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { type ModelDirectiveSelection, resolveModelDirectiveSelection } from "./model-selection.js";

function resolveStoredNumericProfileModelDirective(params: { raw: string; agentDir: string }): {
  modelRaw: string;
  profileId: string;
  profileProvider: string;
} | null {
  const trimmed = params.raw.trim();
  const lastSlash = trimmed.lastIndexOf("/");
  const profileDelimiter = trimmed.indexOf("@", lastSlash + 1);
  if (profileDelimiter <= 0) {
    return null;
  }

  const profileId = trimmed.slice(profileDelimiter + 1).trim();
  if (!/^\d{8}$/.test(profileId)) {
    return null;
  }

  const modelRaw = trimmed.slice(0, profileDelimiter).trim();
  if (!modelRaw) {
    return null;
  }

  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const profile = store.profiles[profileId];
  if (!profile) {
    return null;
  }

  return { modelRaw, profileId, profileProvider: profile.provider };
}

/** Resolves the requested model/profile override from parsed inline directives. */
export function resolveModelSelectionFromDirective(params: {
  directives: InlineDirectives;
  cfg: OpenClawConfig;
  agentDir: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
  modelPolicy?: ModelVisibilityPolicy;
  allowedModelCatalog: Array<{ provider: string; id?: string; name?: string }>;
  provider: string;
  agentId?: string;
  requesterProfileId?: string;
}): {
  modelSelection?: ModelDirectiveSelection;
  profileOverride?: string;
  errorText?: string;
  validateAuthProfileSelection?: () => string | undefined;
} {
  if (!params.directives.hasModelDirective || !params.directives.rawModelDirective) {
    if (params.directives.rawModelProfile) {
      return { errorText: "Auth profile override requires a model selection." };
    }
    return {};
  }

  const raw = params.directives.rawModelDirective.trim();
  if (/^default$/i.test(raw)) {
    return {
      modelSelection: {
        provider: params.defaultProvider,
        model: params.defaultModel,
        isDefault: true,
      },
    };
  }
  const storedNumericProfile =
    params.directives.rawModelProfile === undefined
      ? resolveStoredNumericProfileModelDirective({
          raw,
          agentDir: params.agentDir,
        })
      : null;
  const storedNumericProfileSelection = storedNumericProfile
    ? resolveModelDirectiveSelection({
        raw: storedNumericProfile.modelRaw,
        defaultProvider: params.defaultProvider,
        defaultModel: params.defaultModel,
        aliasIndex: params.aliasIndex,
        allowedModelKeys: params.allowedModelKeys,
        modelPolicy: params.modelPolicy,
        cfg: params.cfg,
        agentId: params.agentId,
        rawRuntime: params.directives.rawModelRuntime,
      })
    : null;
  const useStoredNumericProfile =
    Boolean(storedNumericProfileSelection?.selection) &&
    resolveProviderIdForAuth(storedNumericProfileSelection?.selection?.provider ?? "", {
      config: params.cfg,
    }) ===
      resolveProviderIdForAuth(storedNumericProfile?.profileProvider ?? "", {
        config: params.cfg,
        storedCredential: true,
      });
  const modelRaw =
    useStoredNumericProfile && storedNumericProfile ? storedNumericProfile.modelRaw : raw;

  if (/^[0-9]+$/.test(raw)) {
    return {
      errorText: [
        "Numeric model selection is not supported in chat.",
        "",
        "Browse: /models or /models <provider>",
        "Switch: /model <provider/model>",
      ].join("\n"),
    };
  }

  const resolved = resolveModelDirectiveSelection({
    raw: modelRaw,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    aliasIndex: params.aliasIndex,
    allowedModelKeys: params.allowedModelKeys,
    modelPolicy: params.modelPolicy,
    cfg: params.cfg,
    agentId: params.agentId,
    rawRuntime: params.directives.rawModelRuntime,
  });
  if (resolved.error) {
    return { errorText: resolved.error };
  }
  const modelSelection = resolved.selection;

  let profileOverride: string | undefined;
  let validateAuthProfileSelection: (() => string | undefined) | undefined;
  const rawProfile =
    params.directives.rawModelProfile ??
    (useStoredNumericProfile ? storedNumericProfile?.profileId : undefined);
  if (modelSelection && rawProfile) {
    const profileResolved = resolveProfileOverride({
      rawProfile,
      provider: modelSelection.provider,
      cfg: params.cfg,
      agentDir: params.agentDir,
      requesterProfileId: params.requesterProfileId,
    });
    if (profileResolved.error) {
      return { errorText: profileResolved.error };
    }
    profileOverride = profileResolved.profileId;
    validateAuthProfileSelection = profileResolved.validateSelection;
  }

  return {
    modelSelection,
    profileOverride,
    ...(validateAuthProfileSelection ? { validateAuthProfileSelection } : {}),
  };
}
