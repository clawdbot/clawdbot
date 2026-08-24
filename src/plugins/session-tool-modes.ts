import type { SessionToolModeSelection } from "../../packages/gateway-protocol/src/index.js";
import type { PluginSessionToolModeRegistryRegistration } from "./registry-types.js";
import { getActivePluginSessionExtensionRegistry } from "./runtime.js";

type ResolvedSessionToolMode = {
  selection: SessionToolModeSelection;
  registration?: PluginSessionToolModeRegistryRegistration;
  status: "available" | "unavailable" | "incompatible";
};

const SESSION_TOOL_MODE_RUNTIME_ID = "openclaw";

function listActiveSessionToolModes(): PluginSessionToolModeRegistryRegistration[] {
  return [...(getActivePluginSessionExtensionRegistry()?.sessionToolModes ?? [])];
}

export function resolveSessionToolMode(params: {
  selection?: SessionToolModeSelection;
  runtimeId: string;
}): ResolvedSessionToolMode | undefined {
  const registrations = listActiveSessionToolModes();
  const runtimeId = params.runtimeId.trim().toLowerCase();
  let selection = params.selection;
  if (!selection) {
    if (runtimeId !== SESSION_TOOL_MODE_RUNTIME_ID) {
      return undefined;
    }
    const defaultRegistration = registrations.find((entry) => entry.mode.default === true);
    selection = defaultRegistration
      ? { pluginId: defaultRegistration.pluginId, modeId: defaultRegistration.mode.id }
      : undefined;
  }
  if (!selection) {
    return undefined;
  }
  const registration = registrations.find(
    (entry) => entry.pluginId === selection.pluginId && entry.mode.id === selection.modeId,
  );
  if (!registration) {
    return { selection, status: "unavailable" };
  }
  if (runtimeId !== SESSION_TOOL_MODE_RUNTIME_ID) {
    return { selection, registration, status: "incompatible" };
  }
  return { selection, registration, status: "available" };
}

export function sessionToolModeSelectionError(params: {
  selection: SessionToolModeSelection;
  runtimeId: string;
}): string | undefined {
  const resolved = resolveSessionToolMode(params);
  if (resolved?.status === "available") {
    return undefined;
  }
  if (resolved?.status === "incompatible") {
    return `session Tool mode requires the ${SESSION_TOOL_MODE_RUNTIME_ID} runtime (resolved ${params.runtimeId})`;
  }
  return `unavailable session Tool mode: ${params.selection.pluginId}/${params.selection.modeId}`;
}
