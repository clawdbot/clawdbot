import { normalizePluginHostHookId, type PluginControlUiDescriptor } from "./host-hooks.js";

type NormalizedControlUiBridgeCapabilities = Pick<
  PluginControlUiDescriptor,
  "sessionActions" | "allowChatNavigation"
>;

export function normalizeControlUiBridgeCapabilities(
  descriptor: PluginControlUiDescriptor,
): NormalizedControlUiBridgeCapabilities | null {
  const rawActions = descriptor.sessionActions;
  if (rawActions !== undefined && !Array.isArray(rawActions)) {
    return null;
  }
  const sessionActions = rawActions?.map((actionId) =>
    typeof actionId === "string" ? normalizePluginHostHookId(actionId) : "",
  );
  const allowChatNavigation = descriptor.allowChatNavigation;
  if (
    sessionActions?.some((actionId) => !actionId) ||
    (allowChatNavigation !== undefined && typeof allowChatNavigation !== "boolean") ||
    (descriptor.surface !== "tab" &&
      ((sessionActions?.length ?? 0) > 0 || allowChatNavigation !== undefined))
  ) {
    return null;
  }
  return {
    ...(sessionActions !== undefined ? { sessionActions: [...new Set(sessionActions)] } : {}),
    ...(allowChatNavigation !== undefined ? { allowChatNavigation } : {}),
  };
}
