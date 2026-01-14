import os from "node:os";
import path from "node:path";

import type { ClawdbotConfig } from "../config/config.js";
import {
  CONFIG_PATH_CLAWDBOT,
  createConfigIO,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
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

  const defaults = cfg.agents?.defaults;
  if (defaults) {
    let updatedDefaults = defaults;
    let defaultsChanged = false;

    const updatedWorkspace = normalizeDefaultWorkspacePath(defaults.workspace);
    if (updatedWorkspace && updatedWorkspace !== defaults.workspace) {
      updatedDefaults = { ...updatedDefaults, workspace: updatedWorkspace };
      defaultsChanged = true;
      changes.push(`Updated agents.defaults.workspace → ${updatedWorkspace}`);
    }

    const sandbox = defaults.sandbox;
    if (sandbox) {
      let updatedSandbox = sandbox;
      let sandboxChanged = false;

      const updatedWorkspaceRoot = normalizeDefaultWorkspacePath(
        sandbox.workspaceRoot,
      );
      if (
        updatedWorkspaceRoot &&
        updatedWorkspaceRoot !== sandbox.workspaceRoot
      ) {
        updatedSandbox = {
          ...updatedSandbox,
          workspaceRoot: updatedWorkspaceRoot,
        };
        sandboxChanged = true;
        changes.push(
          `Updated agents.defaults.sandbox.workspaceRoot → ${updatedWorkspaceRoot}`,
        );
      }

      const dockerImage = sandbox.docker?.image;
      const updatedDockerImage = replaceLegacyName(dockerImage);
      if (updatedDockerImage && updatedDockerImage !== dockerImage) {
        updatedSandbox = {
          ...updatedSandbox,
          docker: {
            ...updatedSandbox.docker,
            image: updatedDockerImage,
          },
        };
        sandboxChanged = true;
        changes.push(
          `Updated agents.defaults.sandbox.docker.image → ${updatedDockerImage}`,
        );
      }

      const containerPrefix = sandbox.docker?.containerPrefix;
      const updatedContainerPrefix = replaceLegacyName(containerPrefix);
      if (
        updatedContainerPrefix &&
        updatedContainerPrefix !== containerPrefix
      ) {
        updatedSandbox = {
          ...updatedSandbox,
          docker: {
            ...updatedSandbox.docker,
            containerPrefix: updatedContainerPrefix,
          },
        };
        sandboxChanged = true;
        changes.push(
          `Updated agents.defaults.sandbox.docker.containerPrefix → ${updatedContainerPrefix}`,
        );
      }

      if (sandboxChanged) {
        updatedDefaults = { ...updatedDefaults, sandbox: updatedSandbox };
        defaultsChanged = true;
      }
    }

    if (defaultsChanged) {
      next = {
        ...next,
        agents: {
          ...next.agents,
          defaults: updatedDefaults,
        },
      };
    }
  }

  const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  if (list.length > 0) {
    let listChanged = false;
    const nextList = list.map((agent) => {
      let updatedAgent = agent;
      let agentChanged = false;

      const updatedWorkspace = normalizeDefaultWorkspacePath(agent.workspace);
      if (updatedWorkspace && updatedWorkspace !== agent.workspace) {
        updatedAgent = { ...updatedAgent, workspace: updatedWorkspace };
        agentChanged = true;
        changes.push(
          `Updated agents.list (id "${agent.id}") workspace → ${updatedWorkspace}`,
        );
      }

      const sandbox = agent.sandbox;
      if (sandbox) {
        let updatedSandbox = sandbox;
        let sandboxChanged = false;

        const updatedWorkspaceRoot = normalizeDefaultWorkspacePath(
          sandbox.workspaceRoot,
        );
        if (
          updatedWorkspaceRoot &&
          updatedWorkspaceRoot !== sandbox.workspaceRoot
        ) {
          updatedSandbox = {
            ...updatedSandbox,
            workspaceRoot: updatedWorkspaceRoot,
          };
          sandboxChanged = true;
          changes.push(
            `Updated agents.list (id "${agent.id}") sandbox.workspaceRoot → ${updatedWorkspaceRoot}`,
          );
        }

        const dockerImage = sandbox.docker?.image;
        const updatedDockerImage = replaceLegacyName(dockerImage);
        if (updatedDockerImage && updatedDockerImage !== dockerImage) {
          updatedSandbox = {
            ...updatedSandbox,
            docker: {
              ...updatedSandbox.docker,
              image: updatedDockerImage,
            },
          };
          sandboxChanged = true;
          changes.push(
            `Updated agents.list (id "${agent.id}") sandbox.docker.image → ${updatedDockerImage}`,
          );
        }

        const containerPrefix = sandbox.docker?.containerPrefix;
        const updatedContainerPrefix = replaceLegacyName(containerPrefix);
        if (
          updatedContainerPrefix &&
          updatedContainerPrefix !== containerPrefix
        ) {
          updatedSandbox = {
            ...updatedSandbox,
            docker: {
              ...updatedSandbox.docker,
              containerPrefix: updatedContainerPrefix,
            },
          };
          sandboxChanged = true;
          changes.push(
            `Updated agents.list (id "${agent.id}") sandbox.docker.containerPrefix → ${updatedContainerPrefix}`,
          );
        }

        if (sandboxChanged) {
          updatedAgent = { ...updatedAgent, sandbox: updatedSandbox };
          agentChanged = true;
        }
      }

      if (agentChanged) listChanged = true;
      return agentChanged ? updatedAgent : agent;
    });

    if (listChanged) {
      next = {
        ...next,
        agents: {
          ...next.agents,
          list: nextList,
        },
      };
    }
  }

  const legacyAckReaction = cfg.messages?.ackReaction?.trim();
  if (legacyAckReaction) {
    const hasWhatsAppAck = cfg.channels?.whatsapp?.ackReaction !== undefined;
    if (!hasWhatsAppAck) {
      const legacyScope = cfg.messages?.ackReactionScope ?? "group-mentions";
      let direct = true;
      let group: "always" | "mentions" | "never" = "mentions";
      if (legacyScope === "all") {
        direct = true;
        group = "always";
      } else if (legacyScope === "direct") {
        direct = true;
        group = "never";
      } else if (legacyScope === "group-all") {
        direct = false;
        group = "always";
      } else if (legacyScope === "group-mentions") {
        direct = false;
        group = "mentions";
      }
      next = {
        ...next,
        channels: {
          ...next.channels,
          whatsapp: {
            ...next.channels?.whatsapp,
            ackReaction: { emoji: legacyAckReaction, direct, group },
          },
        },
      };
      changes.push(
        `Copied messages.ackReaction → channels.whatsapp.ackReaction (scope: ${legacyScope}).`,
      );
    }
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
  const parsed = legacySnapshot.parsed as Record<string, unknown>;
  const parsedAgents =
    parsed.agents && typeof parsed.agents === "object"
      ? (parsed.agents as Record<string, unknown>)
      : undefined;
  const parsedDefaults =
    parsedAgents?.defaults && typeof parsedAgents.defaults === "object"
      ? (parsedAgents.defaults as Record<string, unknown>)
      : undefined;
  const parsedLegacyAgent =
    parsed.agent && typeof parsed.agent === "object"
      ? (parsed.agent as Record<string, unknown>)
      : undefined;
  const defaultWorkspace =
    typeof parsedDefaults?.workspace === "string"
      ? parsedDefaults.workspace
      : undefined;
  const legacyWorkspace =
    typeof parsedLegacyAgent?.workspace === "string"
      ? parsedLegacyAgent.workspace
      : undefined;
  const agentWorkspace = defaultWorkspace ?? legacyWorkspace;
  const workspaceLabel = defaultWorkspace
    ? "agents.defaults.workspace"
    : legacyWorkspace
      ? "agent.workspace"
      : "agents.defaults.workspace";

  note(
    [
      `- File exists at ${legacyConfigPath}`,
      gatewayMode ? `- gateway.mode: ${gatewayMode}` : undefined,
      gatewayBind ? `- gateway.bind: ${gatewayBind}` : undefined,
      agentWorkspace ? `- ${workspaceLabel}: ${agentWorkspace}` : undefined,
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
