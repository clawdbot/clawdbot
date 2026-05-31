import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

export function toPluginInteractiveRegistryKey(channel: string, namespace: string): string {
  return `${normalizeOptionalLowercaseString(channel) ?? ""}:${namespace.trim()}`;
}

export function normalizePluginInteractiveNamespace(namespace: string): string {
  return namespace.trim();
}

export function validatePluginInteractiveNamespace(namespace: string): string | null {
  if (!namespace.trim()) {
    return "Interactive handler namespace cannot be empty";
  }
  if (!/^[A-Za-z0-9._-]+$/.test(namespace.trim())) {
    return "Interactive handler namespace must contain only letters, numbers, dots, underscores, and hyphens";
  }
  return null;
}

export function resolvePluginInteractiveMatch<TRegistration>(params: {
  interactiveHandlers: Map<string, TRegistration>;
  channel: string;
  data: string;
}): { registration: TRegistration; namespace: string; payload: string } | null {
  const trimmedData = params.data.trim();
  if (!trimmedData) {
    return null;
  }

  const separatorIndex = trimmedData.indexOf(":");
  const namespace =
    separatorIndex >= 0
      ? trimmedData.slice(0, separatorIndex)
      : normalizePluginInteractiveNamespace(trimmedData);
  const registration = params.interactiveHandlers.get(
    toPluginInteractiveRegistryKey(params.channel, namespace),
  );
  if (!registration) {
    return null;
  }

  return {
    registration,
    namespace,
    payload: separatorIndex >= 0 ? trimmedData.slice(separatorIndex + 1) : "",
  };
}
