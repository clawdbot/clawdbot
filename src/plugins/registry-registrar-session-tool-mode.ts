import { normalizePluginHostHookId, type PluginSessionToolModeRegistration } from "./host-hooks.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord, PluginSessionToolModeRegistryRegistration } from "./registry-types.js";

const profiles = new Set(["minimal", "coding", "messaging", "full"]);

function normalizeLabel(value: unknown): string {
  return typeof value === "string" ? normalizePluginHostHookId(value) : "";
}

function registerPluginSessionToolMode(params: {
  state: PluginRegistryState;
  record: PluginRecord;
  mode: PluginSessionToolModeRegistration;
}): void {
  const { mode, record } = params;
  const id = normalizeLabel(mode.id);
  const label = normalizeLabel(mode.label);
  const controlLabel = normalizeLabel(mode.controlLabel);
  const description = mode.description?.trim();
  if (
    !id ||
    !label ||
    !controlLabel ||
    !profiles.has(mode.toolProfile) ||
    (mode.codeMode !== "direct" && mode.codeMode !== "code")
  ) {
    params.state.pushDiagnostic({
      level: "error",
      pluginId: record.id,
      source: record.source,
      message: "session Tool mode registration requires valid labels, profile, and Code mode",
    });
    return;
  }
  const pluginModes = params.state.registry.sessionToolModes.filter(
    (entry) => entry.pluginId === record.id,
  );
  const error = pluginModes.some((entry) => entry.mode.id === id)
    ? `session Tool mode already registered: ${id}`
    : mode.default === true &&
        params.state.registry.sessionToolModes.some((entry) => entry.mode.default === true)
      ? "session Tool modes may register only one global default"
      : pluginModes.some((entry) => entry.mode.controlLabel !== controlLabel)
        ? "session Tool modes from one plugin must share controlLabel"
        : undefined;
  if (error) {
    params.state.pushDiagnostic({
      level: "error",
      pluginId: record.id,
      source: record.source,
      message: error,
    });
    return;
  }
  params.state.registry.sessionToolModes.push({
    pluginId: record.id,
    pluginName: record.name,
    mode: {
      ...mode,
      id,
      label,
      controlLabel,
      ...(description ? { description } : {}),
    },
    source: record.source,
    rootDir: record.rootDir,
  } satisfies PluginSessionToolModeRegistryRegistration);
}

export function createSessionToolModeRegistrar(state: PluginRegistryState) {
  return {
    registerSessionToolMode: (record: PluginRecord, mode: PluginSessionToolModeRegistration) =>
      registerPluginSessionToolMode({ state, record, mode }),
  };
}
