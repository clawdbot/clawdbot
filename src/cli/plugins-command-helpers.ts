import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginKind } from "../plugins/plugin-kind.types.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { applyExclusiveSlotSelection } from "../plugins/slots.js";
import { buildPluginDiagnosticsReport } from "../plugins/status.js";
import type { PluginLogger } from "../plugins/types.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { theme } from "../terminal/theme.js";

type HookInternalEntryLike = Record<string, unknown> & { enabled?: boolean };

export const quietPluginJsonLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

type SlotSelectionPlugin = {
  id: string;
  kind?: PluginKind | PluginKind[];
};

type SlotSelectionRegistry = {
  plugins: SlotSelectionPlugin[];
};

function mergeRuntimeKinds(
  report: SlotSelectionRegistry,
  runtimeReport: SlotSelectionRegistry,
): SlotSelectionRegistry {
  const runtimeKinds = new Map(
    runtimeReport.plugins
      .filter((plugin) => plugin.kind)
      .map((plugin) => [plugin.id, plugin.kind] as const),
  );
  return {
    plugins: report.plugins.map((plugin) => {
      if (plugin.kind) {
        return plugin;
      }
      const runtimeKind = runtimeKinds.get(plugin.id);
      return runtimeKind ? { ...plugin, kind: runtimeKind } : plugin;
    }),
  };
}

function loadRuntimeKindReportForPlugins(config: OpenClawConfig, pluginIds: readonly string[]) {
  return buildPluginDiagnosticsReport({
    config,
    onlyPluginIds: [...pluginIds],
  });
}

function buildSlotSelectionRegistry(
  config: OpenClawConfig,
  pluginId: string,
): SlotSelectionRegistry {
  const plugins = loadPluginMetadataSnapshot({
    config,
    env: process.env,
  }).plugins.filter((plugin) => plugin.id === pluginId);
  return {
    plugins: plugins.map((plugin) => ({
      id: plugin.id,
      kind: plugin.kind,
    })),
  };
}

export function resolveFileNpmSpecToLocalPath(
  raw: string,
): { ok: true; path: string } | { ok: false; error: string } | null {
  const trimmed = raw.trim();
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("file:")) {
    return null;
  }
  const rest = trimmed.slice("file:".length);
  if (!rest) {
    return { ok: false, error: "unsupported file: spec: missing path" };
  }
  if (rest.startsWith("///")) {
    return { ok: true, path: rest.slice(2) };
  }
  if (rest.startsWith("//localhost/")) {
    return { ok: true, path: rest.slice("//localhost".length) };
  }
  if (rest.startsWith("//")) {
    return {
      ok: false,
      error: 'unsupported file: URL host (expected "file:<path>" or "file:///abs/path")',
    };
  }
  return { ok: true, path: rest };
}

export function applySlotSelectionForPlugin(
  config: OpenClawConfig,
  pluginId: string,
): { config: OpenClawConfig; warnings: string[] } {
  const report = buildSlotSelectionRegistry(config, pluginId);
  const plugin = report.plugins.find((entry) => entry.id === pluginId);
  if (!plugin) {
    return { config, warnings: [] };
  }
  if (!plugin.kind) {
    const runtimeReport = loadRuntimeKindReportForPlugins(config, [plugin.id]);
    const runtimePlugin = runtimeReport.plugins.find((entry) => entry.id === plugin.id);
    if (runtimePlugin?.kind) {
      const result = applyExclusiveSlotSelection({
        config,
        selectedId: runtimePlugin.id,
        selectedKind: runtimePlugin.kind,
        registry: mergeRuntimeKinds(report, runtimeReport),
      });
      return { config: result.config, warnings: result.warnings };
    }
  }
  const result = applyExclusiveSlotSelection({
    config,
    selectedId: plugin.id,
    selectedKind: plugin.kind,
    registry: report,
  });
  return { config: result.config, warnings: result.warnings };
}

export function createPluginInstallLogger(runtime: RuntimeEnv = defaultRuntime): {
  info: (msg: string) => void;
  warn: (msg: string) => void;
} {
  return {
    info: (msg) => runtime.log(msg),
    warn: (msg) => runtime.log(theme.warn(msg)),
  };
}

export function createHookPackInstallLogger(runtime: RuntimeEnv = defaultRuntime): {
  info: (msg: string) => void;
  warn: (msg: string) => void;
} {
  return {
    info: (msg) => runtime.log(msg),
    warn: (msg) => runtime.log(theme.warn(msg)),
  };
}

export function enableInternalHookEntries(
  config: OpenClawConfig,
  hookNames: string[],
): OpenClawConfig {
  const entries = { ...config.hooks?.internal?.entries } as Record<string, HookInternalEntryLike>;

  for (const hookName of hookNames) {
    entries[hookName] = {
      ...entries[hookName],
      enabled: true,
    };
  }

  return {
    ...config,
    hooks: {
      ...config.hooks,
      internal: {
        ...config.hooks?.internal,
        enabled: true,
        entries,
      },
    },
  };
}

export function formatPluginInstallWithHookFallbackError(
  pluginError: string,
  hookError: string,
): string {
  if (/plugin already exists: .+ \(delete it first\)/.test(pluginError)) {
    return `${pluginError}\nUse \`openclaw plugins update <id-or-npm-spec>\` to upgrade the tracked plugin, or rerun install with \`--force\` to replace it.`;
  }
  if (
    pluginError.startsWith("Invalid extensions directory:") ||
    pluginError === "Invalid path: must stay within extensions directory"
  ) {
    return pluginError;
  }
  return `${pluginError}\nAlso not a valid hook pack: ${hookError}`;
}

export function logHookPackRestartHint(runtime: RuntimeEnv = defaultRuntime) {
  runtime.log("Restart the gateway to load hooks.");
}

export function logSlotWarnings(warnings: string[], runtime: RuntimeEnv = defaultRuntime) {
  if (warnings.length === 0) {
    return;
  }
  for (const warning of warnings) {
    runtime.log(theme.warn(warning));
  }
}

export function parseNpmPrefixSpec(raw: string): string | null {
  const trimmed = raw.trim();
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("npm:")) {
    return null;
  }
  return trimmed.slice("npm:".length).trim();
}
