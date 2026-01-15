import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  CONFIG_PATH_CLAWDBOT,
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  resolveConfigSnapshotHash,
  validateConfigObject,
  writeConfigFile,
} from "../config/config.js";
import { applyLegacyMigrations } from "../config/legacy.js";
import { applyMergePatch } from "../config/merge-patch.js";
import { buildConfigSchema } from "../config/schema.js";
import { loadClawdbotPlugins } from "../plugins/loader.js";
import {
  ErrorCodes,
  formatValidationErrors,
  validateConfigGetParams,
  validateConfigPatchParams,
  validateConfigSchemaParams,
  validateConfigSetParams,
} from "./protocol/index.js";
import type { BridgeMethodHandler } from "./server-bridge-types.js";

function resolveBaseHash(params: unknown): string | null {
  const raw = (params as { baseHash?: unknown })?.baseHash;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function requireConfigBaseHash(
  params: unknown,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): { ok: true } | { ok: false; error: { code: string; message: string } } {
  if (!snapshot.exists) return { ok: true };
  const snapshotHash = resolveConfigSnapshotHash(snapshot);
  if (!snapshotHash) {
    return {
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: "config base hash unavailable; re-run config.get and retry",
      },
    };
  }
  const baseHash = resolveBaseHash(params);
  if (!baseHash) {
    return {
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: "config base hash required; re-run config.get and retry",
      },
    };
  }
  if (baseHash !== snapshotHash) {
    return {
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: "config changed since last load; re-run config.get and retry",
      },
    };
  }
  return { ok: true };
}

export const handleConfigBridgeMethods: BridgeMethodHandler = async (
  _ctx,
  _nodeId,
  method,
  params,
) => {
  switch (method) {
    case "config.get": {
      if (!validateConfigGetParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid config.get params: ${formatValidationErrors(validateConfigGetParams.errors)}`,
          },
        };
      }
      const snapshot = await readConfigFileSnapshot();
      return { ok: true, payloadJSON: JSON.stringify(snapshot) };
    }
    case "config.schema": {
      if (!validateConfigSchemaParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid config.schema params: ${formatValidationErrors(validateConfigSchemaParams.errors)}`,
          },
        };
      }
      const cfg = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
      const pluginRegistry = loadClawdbotPlugins({
        config: cfg,
        workspaceDir,
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      });
      const schema = buildConfigSchema({
        plugins: pluginRegistry.plugins.map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          description: plugin.description,
          configUiHints: plugin.configUiHints,
        })),
        channels: pluginRegistry.channels.map((entry) => ({
          id: entry.plugin.id,
          label: entry.plugin.meta.label,
          description: entry.plugin.meta.blurb,
        })),
      });
      return { ok: true, payloadJSON: JSON.stringify(schema) };
    }
    case "config.set": {
      if (!validateConfigSetParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid config.set params: ${formatValidationErrors(validateConfigSetParams.errors)}`,
          },
        };
      }
      const snapshot = await readConfigFileSnapshot();
      const guard = requireConfigBaseHash(params, snapshot);
      if (!guard.ok) {
        return { ok: false, error: guard.error };
      }
      const rawValue = (params as { raw?: unknown }).raw;
      if (typeof rawValue !== "string") {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: "invalid config.set params: raw (string) required",
          },
        };
      }
      const parsedRes = parseConfigJson5(rawValue);
      if (!parsedRes.ok) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: parsedRes.error,
          },
        };
      }
      const validated = validateConfigObject(parsedRes.parsed);
      if (!validated.ok) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: "invalid config",
            details: { issues: validated.issues },
          },
        };
      }
      await writeConfigFile(validated.config);
      return {
        ok: true,
        payloadJSON: JSON.stringify({
          ok: true,
          path: CONFIG_PATH_CLAWDBOT,
          config: validated.config,
        }),
      };
    }
    case "config.patch": {
      if (!validateConfigPatchParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid config.patch params: ${formatValidationErrors(validateConfigPatchParams.errors)}`,
          },
        };
      }
      const snapshot = await readConfigFileSnapshot();
      const guard = requireConfigBaseHash(params, snapshot);
      if (!guard.ok) {
        return { ok: false, error: guard.error };
      }
      if (!snapshot.valid) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: "invalid config; fix before patching",
          },
        };
      }
      const rawValue = (params as { raw?: unknown }).raw;
      if (typeof rawValue !== "string") {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: "invalid config.patch params: raw (string) required",
          },
        };
      }
      const parsedRes = parseConfigJson5(rawValue);
      if (!parsedRes.ok) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: parsedRes.error,
          },
        };
      }
      if (
        !parsedRes.parsed ||
        typeof parsedRes.parsed !== "object" ||
        Array.isArray(parsedRes.parsed)
      ) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: "config.patch raw must be an object",
          },
        };
      }
      const merged = applyMergePatch(snapshot.config, parsedRes.parsed);
      const migrated = applyLegacyMigrations(merged);
      const resolved = migrated.next ?? merged;
      const validated = validateConfigObject(resolved);
      if (!validated.ok) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: "invalid config",
            details: { issues: validated.issues },
          },
        };
      }
      await writeConfigFile(validated.config);
      return {
        ok: true,
        payloadJSON: JSON.stringify({
          ok: true,
          path: CONFIG_PATH_CLAWDBOT,
          config: validated.config,
        }),
      };
    }
    default:
      return null;
  }
};
