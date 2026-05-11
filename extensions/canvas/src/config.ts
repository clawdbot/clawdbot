import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolvePluginConfigObject,
} from "openclaw/plugin-sdk/plugin-config-runtime";
import { isTruthyEnvValue } from "openclaw/plugin-sdk/runtime-env";

export type CanvasHostConfig = {
  enabled?: boolean;
  root?: string;
  port?: number;
  liveReload?: boolean;
};

export type CanvasPluginConfig = {
  host?: CanvasHostConfig;
};

type CanvasPluginConfigSchema = {
  parse: (value: unknown) => CanvasPluginConfig;
  uiHints: Record<string, { label: string; help?: string; advanced?: boolean }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseCanvasHostConfig(value: unknown): CanvasHostConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    ...(readBoolean(value.enabled) !== undefined ? { enabled: readBoolean(value.enabled) } : {}),
    ...(readString(value.root) !== undefined ? { root: readString(value.root) } : {}),
    ...(readPositiveInteger(value.port) !== undefined
      ? { port: readPositiveInteger(value.port) }
      : {}),
    ...(readBoolean(value.liveReload) !== undefined
      ? { liveReload: readBoolean(value.liveReload) }
      : {}),
  };
}

export function parseCanvasPluginConfig(value: unknown): CanvasPluginConfig {
  if (!isRecord(value)) {
    return {};
  }
  const host = parseCanvasHostConfig(value.host);
  return host ? { host } : {};
}

export function isCanvasPluginEnabled(config?: OpenClawConfig): boolean {
  if (!config) {
    return true;
  }
  return resolveEffectiveEnableState({
    id: "canvas",
    origin: "bundled",
    config: normalizePluginsConfig(config.plugins),
    rootConfig: config,
    enabledByDefault: true,
  }).enabled;
}

export function resolveCanvasHostConfig(params: {
  config?: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
}): CanvasHostConfig {
  const pluginConfig =
    params.pluginConfig ?? resolvePluginConfigObject(params.config, "canvas") ?? {};
  const parsedPluginConfig = parseCanvasPluginConfig(pluginConfig);
  return parsedPluginConfig.host ?? {};
}

export function isCanvasHostEnabled(config?: OpenClawConfig): boolean {
  if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_CANVAS_HOST)) {
    return false;
  }
  if (!isCanvasPluginEnabled(config)) {
    return false;
  }
  return resolveCanvasHostConfig({ config }).enabled !== false;
}

export const canvasConfigSchema: CanvasPluginConfigSchema = {
  parse: parseCanvasPluginConfig,
  uiHints: {
    host: {
      label: "Canvas Host",
      help: "Serves local Canvas and A2UI files for paired nodes.",
      advanced: true,
    },
    "host.enabled": {
      label: "Canvas Host Enabled",
      advanced: true,
    },
    "host.root": {
      label: "Canvas Host Root Directory",
      help: "Directory to serve. Defaults to the OpenClaw state canvas directory.",
      advanced: true,
    },
    "host.port": {
      label: "Canvas Host Port",
      advanced: true,
    },
    "host.liveReload": {
      label: "Canvas Host Live Reload",
      advanced: true,
    },
  },
};
