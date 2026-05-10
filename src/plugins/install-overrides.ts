import path from "node:path";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { isRecord, resolveUserPath } from "../utils.js";

export const PLUGIN_INSTALL_OVERRIDES_ENV = "OPENCLAW_PLUGIN_INSTALL_OVERRIDES";
export const ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV = "OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES";

export type PluginInstallOverride =
  | {
      kind: "npm";
      spec: string;
    }
  | {
      kind: "npm-pack";
      archivePath: string;
    };

function overrideAllowed(env: NodeJS.ProcessEnv): boolean {
  return env[ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV]?.trim() === "1";
}

function parseOverrideSpec(raw: string): PluginInstallOverride | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const npmPrefix = "npm:";
  if (trimmed.startsWith(npmPrefix)) {
    const spec = trimmed.slice(npmPrefix.length).trim();
    return spec && parseRegistryNpmSpec(spec) ? { kind: "npm", spec } : null;
  }
  const npmPackPrefix = "npm-pack:";
  if (trimmed.startsWith(npmPackPrefix)) {
    const rawPath = trimmed.slice(npmPackPrefix.length).trim();
    if (!rawPath) {
      return null;
    }
    return { kind: "npm-pack", archivePath: path.resolve(resolveUserPath(rawPath)) };
  }
  return null;
}

export function resolvePluginInstallOverride(params: {
  pluginId: string;
  env?: NodeJS.ProcessEnv;
}): PluginInstallOverride | null {
  const env = params.env ?? process.env;
  if (!overrideAllowed(env)) {
    return null;
  }
  const raw = env[PLUGIN_INSTALL_OVERRIDES_ENV]?.trim();
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const value = parsed[params.pluginId];
  return typeof value === "string" ? parseOverrideSpec(value) : null;
}
