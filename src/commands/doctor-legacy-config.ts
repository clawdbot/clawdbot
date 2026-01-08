import os from "node:os";
import path from "node:path";

import { note } from "@clack/prompts";

import type { ClawdbotConfig } from "../config/config.js";
import {
  CONFIG_PATH_CLAWDBOT,
  createConfigIO,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";

function resolveLegacyConfigPath(env: NodeJS.ProcessEnv): string {
  const override = env.CLAWDIS_CONFIG_PATH?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".clawdis", "clawdis.json");
}

function normalizeDefaultWorkspacePath(
  value: string | undefined,
): string | undefined {
  if (!value) return value;

  const resolved = resolveUserPath(value);
  const home = os.homedir();

  const next = [
    ["clawdis", "clawd"],
    ["clawdbot", "clawd"],
  ].reduce((acc, [from, to]) => {
    const fromPrefix = path.join(home, from);
    if (acc === fromPrefix) return path.join(home, to);
    const withSep = `${fromPrefix}${path.sep}`;
    if (acc.startsWith(withSep)) {
      return path.join(home, to).concat(acc.slice(fromPrefix.length));
    }
    return acc;
  }, resolved);

  return next === resolved ? value : next;
}

export function replaceLegacyName(
  value: string | undefined,
): string | undefined {
  if (!value) return value;
  const replacedClawdis = value.replace(/clawdis/g, "clawdbot");
  return replacedClawdis.replace(/clawd(?!bot)/g, "clawdbot");
}

export function replaceModernName(
  value: string | undefined,
): string | undefined {
  if (!value) return value;
  if (!value.includes("clawdbot")) return value;
  return value.replace(/clawdbot/g, "clawdis");
}

export function normalizeLegacyConfigValues(cfg: ClawdbotConfig): {
  config: ClawdbotConfig;
  changes: string[];
} {
  const changes: string[] = [];
  let next: ClawdbotConfig = cfg;

  const workspace = cfg.agent?.workspace;
  const updatedWorkspace = normalizeDefaultWorkspacePath(workspace);
  if (updatedWorkspace && updatedWorkspace !== workspace) {
    next = {
      ...next,
      agent: {
        ...next.agent,
        workspace: updatedWorkspace,
      },
    };
    changes.push(`Updated agent.workspace → ${updatedWorkspace}`);
  }

  const workspaceRoot = cfg.agent?.sandbox?.workspaceRoot;
  const updatedWorkspaceRoot = normalizeDefaultWorkspacePath(workspaceRoot);
  if (updatedWorkspaceRoot && updatedWorkspaceRoot !== workspaceRoot) {
    next = {
      ...next,
      agent: {
        ...next.agent,
        sandbox: {
          ...next.agent?.sandbox,
          workspaceRoot: updatedWorkspaceRoot,
        },
      },
    };
    changes.push(
      `Updated agent.sandbox.workspaceRoot → ${updatedWorkspaceRoot}`,
    );
  }

  const dockerImage = cfg.agent?.sandbox?.docker?.image;
  const updatedDockerImage = replaceLegacyName(dockerImage);
  if (updatedDockerImage && updatedDockerImage !== dockerImage) {
    next = {
      ...next,
      agent: {
        ...next.agent,
        sandbox: {
          ...next.agent?.sandbox,
          docker: {
            ...next.agent?.sandbox?.docker,
            image: updatedDockerImage,
          },
        },
      },
    };
    changes.push(`Updated agent.sandbox.docker.image → ${updatedDockerImage}`);
  }

  const containerPrefix = cfg.agent?.sandbox?.docker?.containerPrefix;
  const updatedContainerPrefix = replaceLegacyName(containerPrefix);
  if (updatedContainerPrefix && updatedContainerPrefix !== containerPrefix) {
    next = {
      ...next,
      agent: {
        ...next.agent,
        sandbox: {
          ...next.agent?.sandbox,
          docker: {
            ...next.agent?.sandbox?.docker,
            containerPrefix: updatedContainerPrefix,
          },
        },
      },
    };
    changes.push(
      `Updated agent.sandbox.docker.containerPrefix → ${updatedContainerPrefix}`,
    );
  }

  return { config: next, changes };
}

export async function maybeMigrateLegacyConfigFile(runtime: RuntimeEnv) {
  const legacyConfigPath = resolveLegacyConfigPath(process.env);
  if (legacyConfigPath === CONFIG_PATH_CLAWDBOT) return;

  const legacyIo = createConfigIO({ configPath: legacyConfigPath });
  const legacySnapshot = await legacyIo.readConfigFileSnapshot();
  if (!legacySnapshot.exists) return;

  const currentSnapshot = await readConfigFileSnapshot();
  if (currentSnapshot.exists) {
    note(
      `Legacy config still exists at ${legacyConfigPath}. Current config at ${CONFIG_PATH_CLAWDBOT}.`,
      "Legacy config",
    );
    return;
  }

  const gatewayMode =
    typeof (legacySnapshot.parsed as ClawdbotConfig)?.gateway?.mode === "string"
      ? (legacySnapshot.parsed as ClawdbotConfig).gateway?.mode
      : undefined;
  const gatewayBind =
    typeof (legacySnapshot.parsed as ClawdbotConfig)?.gateway?.bind === "string"
      ? (legacySnapshot.parsed as ClawdbotConfig).gateway?.bind
      : undefined;
  const agentWorkspace =
    typeof (legacySnapshot.parsed as ClawdbotConfig)?.agent?.workspace ===
    "string"
      ? (legacySnapshot.parsed as ClawdbotConfig).agent?.workspace
      : undefined;

  note(
    [
      `- File exists at ${legacyConfigPath}`,
      gatewayMode ? `- gateway.mode: ${gatewayMode}` : undefined,
      gatewayBind ? `- gateway.bind: ${gatewayBind}` : undefined,
      agentWorkspace ? `- agent.workspace: ${agentWorkspace}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
    "Legacy Clawdis config detected",
  );

  let nextConfig = legacySnapshot.valid ? legacySnapshot.config : null;
  const { config: migratedConfig, changes } = migrateLegacyConfig(
    legacySnapshot.parsed,
  );
  if (migratedConfig) {
    nextConfig = migratedConfig;
  } else if (!nextConfig) {
    note(
      `Legacy config at ${legacyConfigPath} is invalid; skipping migration.`,
      "Legacy config",
    );
    return;
  }

  const normalized = normalizeLegacyConfigValues(nextConfig);
  const mergedChanges = [...changes, ...normalized.changes];
  if (mergedChanges.length > 0) {
    note(mergedChanges.join("\n"), "Doctor changes");
  }

  await writeConfigFile(normalized.config);
  runtime.log(`Migrated legacy config to ${CONFIG_PATH_CLAWDBOT}`);
}
