// Shared legacy runtime policy projection for selected canonical model refs.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { isRecord } from "./legacy-config-record-shared.js";

/** Select canonical refs owned by a provider, preserving config order and duplicates. */
export function selectedCanonicalModelRefsForRuntimePolicy(
  rawModel: unknown,
  provider: string,
): string[] {
  const refs: string[] = [];
  const addRef = (rawRef: unknown) => {
    if (typeof rawRef !== "string") {
      return;
    }
    const ref = rawRef.trim();
    const slash = ref.indexOf("/");
    if (
      slash <= 0 ||
      slash >= ref.length - 1 ||
      normalizeProviderId(ref.slice(0, slash)) !== normalizeProviderId(provider)
    ) {
      return;
    }
    refs.push(ref);
  };

  if (typeof rawModel === "string") {
    addRef(rawModel);
    return refs;
  }
  if (!isRecord(rawModel)) {
    return refs;
  }
  addRef(rawModel.primary);
  if (Array.isArray(rawModel.fallbacks)) {
    for (const fallback of rawModel.fallbacks) {
      addRef(fallback);
    }
  }
  return refs;
}

/** Add runtime policy unless the model entry already selects an explicit non-auto runtime. */
export function modelEntryWithRuntimePolicy(
  entry: unknown,
  runtime: string,
): { changed: boolean; entry: Record<string, unknown> } {
  const next = isRecord(entry) ? { ...entry } : {};
  const currentRuntime = isRecord(next.agentRuntime) ? next.agentRuntime : undefined;
  const currentRuntimeId = normalizeOptionalLowercaseString(currentRuntime?.id);
  if (currentRuntimeId && currentRuntimeId !== "auto") {
    return { changed: false, entry: next };
  }
  next.agentRuntime = { ...currentRuntime, id: runtime };
  return { changed: true, entry: next };
}
