import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope-config.js";
import { composeConfigLayers } from "../../config/config-layers.js";
import { parseConfigJson5 } from "../../config/config.js";
import {
  resolveConfigEnvVars,
  type EnvSubstitutionWarning,
} from "../../config/env-substitution.js";
import { resolveConfigIncludes } from "../../config/includes.js";
import type { ReadConfigFileSnapshotWithPluginMetadataResult } from "../../config/io.js";
import { resolveIncludeRoots } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { validateConfigObjectWithPlugins } from "../../config/validation.js";
import { createConfigValidationMetadataPluginIdScope } from "../../plugins/gateway-startup-plugin-ids.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { isPlainObject, resolveUserPath } from "../../utils.js";

type ConfigLayerArgument = { id: string; path: string };

function parseConfigLayerArguments(value: unknown): ConfigLayerArgument[] {
  if (value === undefined) {
    return [];
  }
  const values =
    typeof value === "string"
      ? [value]
      : Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? value
        : null;
  if (!values) {
    throw new Error("--config-layer must be repeated as <id=path>");
  }

  const seen = new Set<string>();
  return values.map((entry) => {
    const separator = entry.indexOf("=");
    const id = entry.slice(0, separator).trim();
    const filePath = entry.slice(separator + 1).trim();
    if (separator <= 0 || !id || !filePath) {
      throw new Error("invalid --config-layer value: " + entry);
    }
    if (seen.has(id)) {
      throw new Error("duplicate --config-layer id: " + id);
    }
    seen.add(id);
    return { id, path: path.resolve(resolveUserPath(filePath)) };
  });
}

function formatValidationIssues(issues: ReadonlyArray<{ path: string; message: string }>): string {
  return issues.map((issue) => (issue.path || "<root>") + ": " + issue.message).join("\n");
}

export async function loadConfigLayers(
  value: unknown,
): Promise<ReadConfigFileSnapshotWithPluginMetadataResult | null> {
  const descriptors = parseConfigLayerArguments(value);
  if (descriptors.length === 0) {
    return null;
  }
  const firstDescriptor = descriptors[0];
  if (!firstDescriptor) {
    return null;
  }

  const envWarnings: EnvSubstitutionWarning[] = [];
  const allowedRoots = resolveIncludeRoots(process.env);
  const layers = await Promise.all(
    descriptors.map(async (descriptor) => {
      const raw = await readFile(descriptor.path, "utf8");
      const parsed = parseConfigJson5(raw);
      if (!parsed.ok) {
        throw new Error(`failed to parse config layer "${descriptor.id}": ${parsed.error}`);
      }
      const included = resolveConfigIncludes(parsed.parsed, descriptor.path, undefined, {
        allowedRoots,
      });
      const resolved = resolveConfigEnvVars(included, process.env, {
        onMissing: (warning) => envWarnings.push(warning),
      });
      if (!isPlainObject(resolved)) {
        throw new Error(`config layer "${descriptor.id}" must contain an object root`);
      }
      if (resolved.meta !== undefined || resolved.env !== undefined) {
        throw new Error(
          'config layer "' +
            descriptor.id +
            '" cannot declare bootstrap-owned root keys meta or env',
        );
      }
      return { id: descriptor.id, config: resolved };
    }),
  );

  const composed = composeConfigLayers(layers);
  if (!composed.valid) {
    throw new Error(
      "configuration layer conflicts:\n" + JSON.stringify(composed.findings, null, 2),
    );
  }

  const sourceConfig = composed.config as OpenClawConfig;
  const defaultAgentId = resolveDefaultAgentId(sourceConfig);
  const pluginMetadataSnapshot = resolvePluginMetadataSnapshot({
    config: sourceConfig,
    workspaceDir: resolveAgentWorkspaceDir(sourceConfig, defaultAgentId, process.env),
    env: process.env,
    allowWorkspaceScopedCurrent: true,
    pluginIdScope: createConfigValidationMetadataPluginIdScope({
      config: sourceConfig,
      env: process.env,
    }),
  });
  const validated = validateConfigObjectWithPlugins(sourceConfig, {
    env: process.env,
    pluginMetadataSnapshot,
    sourceRaw: sourceConfig,
  });
  if (!validated.ok) {
    throw new Error("invalid composed configuration:\n" + formatValidationIssues(validated.issues));
  }

  const raw = JSON.stringify(sourceConfig, null, 2);
  return {
    snapshot: {
      path: firstDescriptor.path,
      exists: true,
      raw,
      parsed: sourceConfig,
      sourceConfig,
      resolved: sourceConfig,
      valid: true,
      runtimeConfig: validated.config,
      config: validated.config,
      issues: [],
      warnings: [
        ...validated.warnings,
        ...envWarnings.map((warning) => ({
          path: warning.configPath,
          message: `Missing env var "${warning.varName}" - feature using this value will be unavailable`,
        })),
      ],
      legacyIssues: [],
    },
    pluginMetadataSnapshot,
  };
}
