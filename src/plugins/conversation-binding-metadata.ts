export type PluginBindingMetadata = {
  pluginBindingOwner: "plugin";
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  summary?: string;
  detachHint?: string;
  data?: Record<string, unknown>;
  bindingAttemptId?: string;
};

export function isPluginOwnedBindingMetadata(metadata: unknown): metadata is PluginBindingMetadata {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  // SAFETY: The object guard permits property inspection; required fields are checked below.
  const record = metadata as Record<string, unknown>;
  return (
    record.pluginBindingOwner === "plugin" &&
    typeof record.pluginId === "string" &&
    typeof record.pluginRoot === "string"
  );
}

export function isPluginOwnedSessionBindingRecord(
  record: { metadata?: Record<string, unknown> } | null | undefined,
): boolean {
  return isPluginOwnedBindingMetadata(record?.metadata);
}
