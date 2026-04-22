type ModelDisplaySelectionParams = {
  runtimeProvider?: string | null;
  runtimeModel?: string | null;
  overrideProvider?: string | null;
  overrideModel?: string | null;
  fallbackModel?: string | null;
};

export function resolveModelDisplayRef(params: ModelDisplaySelectionParams): string | undefined {
  const runtimeModel = params.runtimeModel?.trim();
  const runtimeProvider = params.runtimeProvider?.trim();
  if (runtimeModel) {
    if (runtimeModel.includes("/")) {
      return runtimeModel;
    }
    if (runtimeProvider) {
      return `${runtimeProvider}/${runtimeModel}`;
    }
    return runtimeModel;
  }
  if (runtimeProvider) {
    return runtimeProvider;
  }

  const overrideModel = params.overrideModel?.trim();
  const overrideProvider = params.overrideProvider?.trim();
  if (overrideModel) {
    if (overrideModel.includes("/")) {
      return overrideModel;
    }
    if (overrideProvider) {
      return `${overrideProvider}/${overrideModel}`;
    }
    return overrideModel;
  }
  if (overrideProvider) {
    return overrideProvider;
  }

  const fallbackModel = params.fallbackModel?.trim();
  return fallbackModel || undefined;
}

export function resolveModelDisplayName(params: ModelDisplaySelectionParams): string {
  const modelRef = resolveModelDisplayRef(params);
  if (!modelRef) {
    return "model n/a";
  }
  const slash = modelRef.lastIndexOf("/");
  if (slash >= 0 && slash < modelRef.length - 1) {
    return modelRef.slice(slash + 1);
  }
  return modelRef;
}

type SessionInfoModelSelectionParams = {
  currentProvider?: string | null;
  currentModel?: string | null;
  defaultProvider?: string | null;
  defaultModel?: string | null;
  entryProvider?: string | null;
  entryModel?: string | null;
  overrideProvider?: string | null;
  overrideModel?: string | null;
};

export function resolveSessionInfoModelSelection(params: SessionInfoModelSelectionParams): {
  modelProvider?: string;
  model?: string;
} {
  const fallbackProvider = params.currentProvider ?? params.defaultProvider ?? undefined;
  const fallbackModel = params.currentModel ?? params.defaultModel ?? undefined;

  if (params.entryProvider !== undefined || params.entryModel !== undefined) {
    return {
      modelProvider: params.entryProvider ?? fallbackProvider,
      model: params.entryModel ?? fallbackModel,
    };
  }

  const overrideModel = params.overrideModel?.trim();
  if (overrideModel) {
    const overrideProvider = params.overrideProvider?.trim();
    return {
      modelProvider: overrideProvider || fallbackProvider,
      model: overrideModel,
    };
  }

  return {
    modelProvider: fallbackProvider,
    model: fallbackModel,
  };
}
