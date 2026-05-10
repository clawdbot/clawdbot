import type { SessionEntry } from "../config/sessions.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export type ModelOverrideSelection = {
  provider: string;
  model: string;
  isDefault?: boolean;
};

function clearFallbackOrigin(entry: SessionEntry): boolean {
  let updated = false;
  if (entry.modelOverrideFallbackOriginProvider !== undefined) {
    delete entry.modelOverrideFallbackOriginProvider;
    updated = true;
  }
  if (entry.modelOverrideFallbackOriginModel !== undefined) {
    delete entry.modelOverrideFallbackOriginModel;
    updated = true;
  }
  return updated;
}

export function applyModelOverrideToSessionEntry(params: {
  entry: SessionEntry;
  selection: ModelOverrideSelection;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
  preserveAuthProfileOverride?: boolean;
  selectionSource?: "auto" | "user";
  markLiveSwitchPending?: boolean;
}): { updated: boolean } {
  const { entry, selection, profileOverride } = params;
  const profileOverrideSource = params.profileOverrideSource ?? "user";
  const selectionSource = params.selectionSource ?? "user";
  let updated = false;
  let selectionUpdated = false;

  if (selection.isDefault) {
    if (entry.providerOverride) {
      delete entry.providerOverride;
      updated = true;
      selectionUpdated = true;
    }
    if (entry.modelOverride) {
      delete entry.modelOverride;
      updated = true;
      selectionUpdated = true;
    }
    if (entry.modelOverrideSource) {
      delete entry.modelOverrideSource;
      updated = true;
    }
    updated = clearFallbackOrigin(entry) || updated;
  } else {
    if (entry.providerOverride !== selection.provider) {
      entry.providerOverride = selection.provider;
      updated = true;
      selectionUpdated = true;
    }
    if (entry.modelOverride !== selection.model) {
      entry.modelOverride = selection.model;
      updated = true;
      selectionUpdated = true;
    }
    if (entry.modelOverrideSource !== selectionSource) {
      entry.modelOverrideSource = selectionSource;
      updated = true;
    }
    updated = clearFallbackOrigin(entry) || updated;
  }

  // Model overrides supersede previously recorded runtime model identity.
  // If runtime fields are stale (or the override changed), clear them so status
  // surfaces reflect the selected model immediately.
  const runtimeModel = normalizeOptionalString(entry.model) ?? "";
  const runtimeProvider = normalizeOptionalString(entry.modelProvider) ?? "";
  const runtimePresent = runtimeModel.length > 0 || runtimeProvider.length > 0;
  const runtimeAligned =
    runtimeModel === selection.model &&
    (runtimeProvider.length === 0 || runtimeProvider === selection.provider);
  if (runtimePresent && (selectionUpdated || !runtimeAligned)) {
    if (entry.model !== undefined) {
      delete entry.model;
      updated = true;
    }
    if (entry.modelProvider !== undefined) {
      delete entry.modelProvider;
      updated = true;
    }
  }

  // contextTokens are derived from the active session model. When the selected
  // model changes (or runtime model is already stale), the cached window can
  // pin the session to an older/smaller limit until another run refreshes it.
  if (
    entry.contextTokens !== undefined &&
    (selectionUpdated || (runtimePresent && !runtimeAligned))
  ) {
    delete entry.contextTokens;
    updated = true;
  }

  if (profileOverride) {
    if (entry.authProfileOverride !== profileOverride) {
      entry.authProfileOverride = profileOverride;
      updated = true;
    }
    if (entry.authProfileOverrideSource !== profileOverrideSource) {
      entry.authProfileOverrideSource = profileOverrideSource;
      updated = true;
    }
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      delete entry.authProfileOverrideCompactionCount;
      updated = true;
    }
  } else if (!params.preserveAuthProfileOverride) {
    if (entry.authProfileOverride) {
      delete entry.authProfileOverride;
      updated = true;
    }
    if (entry.authProfileOverrideSource) {
      delete entry.authProfileOverrideSource;
      updated = true;
    }
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      delete entry.authProfileOverrideCompactionCount;
      updated = true;
    }
  }

  // Clear stale fallback notice when the user explicitly switches models.
  if (updated) {
    if (selectionUpdated && params.markLiveSwitchPending) {
      entry.liveModelSwitchPending = true;
    }
    delete entry.fallbackNoticeSelectedModel;
    delete entry.fallbackNoticeActiveModel;
    delete entry.fallbackNoticeReason;
    entry.updatedAt = Date.now();
  }

  return { updated };
}

function wrappedOverrideModel(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function repairProviderWrappedModelOverride(params: {
  entry: SessionEntry;
  defaultProvider: string;
  defaultModel?: string;
}): { updated: boolean } {
  const overrideProvider = normalizeOptionalString(params.entry.providerOverride);
  const overrideModel = normalizeOptionalString(params.entry.modelOverride);
  if (!overrideProvider || !overrideModel) {
    return { updated: false };
  }

  const wrappedModel = wrappedOverrideModel(overrideProvider, overrideModel);
  const runtimeProvider = normalizeOptionalString(params.entry.modelProvider);
  const runtimeModel = normalizeOptionalString(params.entry.model);
  if (runtimeProvider && runtimeModel === wrappedModel && runtimeProvider !== overrideProvider) {
    return applyModelOverrideToSessionEntry({
      entry: params.entry,
      selection: {
        provider: runtimeProvider,
        model: runtimeModel,
        isDefault:
          runtimeProvider === params.defaultProvider && runtimeModel === params.defaultModel,
      },
      selectionSource: params.entry.modelOverrideSource === "auto" ? "auto" : "user",
    });
  }

  if (params.defaultProvider !== overrideProvider && params.defaultModel === wrappedModel) {
    return applyModelOverrideToSessionEntry({
      entry: params.entry,
      selection: {
        provider: params.defaultProvider,
        model: params.defaultModel,
        isDefault: true,
      },
    });
  }

  return { updated: false };
}
