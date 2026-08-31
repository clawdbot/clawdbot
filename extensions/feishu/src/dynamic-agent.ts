// Feishu plugin module implements dynamic agent behavior.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveChannelConfigWrites } from "openclaw/plugin-sdk/channel-config-writes";
import { normalizeAccountId, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import type { DynamicAgentCreationConfig } from "./types.js";

type MaybeCreateDynamicAgentResult = {
  created: boolean;
  updatedCfg: OpenClawConfig;
  agentId?: string;
};

type DynamicAgentMutationResult = {
  created: boolean;
  agentId?: string;
};

class DynamicAgentMutationSkipped extends Error {
  constructor(readonly cfg: OpenClawConfig) {
    super("dynamic agent mutation skipped");
  }
}

function hasDefaultDirectRoute(
  cfg: OpenClawConfig,
  accountId: string,
  senderOpenId: string,
): boolean {
  return (
    resolveAgentRoute({
      cfg,
      channel: "feishu",
      accountId,
      peer: { kind: "direct", id: senderOpenId },
    }).matchedBy === "default"
  );
}

function resolveDynamicAgentConfig(
  cfg: OpenClawConfig,
  accountId: string,
): DynamicAgentCreationConfig | undefined {
  return resolveFeishuAccount({ cfg, accountId }).config.dynamicAgentCreation as
    | DynamicAgentCreationConfig
    | undefined;
}

function isAtDynamicAgentLimit(
  cfg: OpenClawConfig,
  dynamicCfg: DynamicAgentCreationConfig,
): boolean {
  if (dynamicCfg.maxAgents === undefined) {
    return false;
  }
  const feishuAgentCount = (cfg.agents?.list ?? []).filter((agent) =>
    agent.id.startsWith("feishu-"),
  ).length;
  return feishuAgentCount >= dynamicCfg.maxAgents;
}

function resolveDynamicAgentId(accountId: string, senderOpenId: string): string {
  if (accountId === "default") {
    return `feishu-${senderOpenId}`;
  }
  const identityDigest = createHash("sha256")
    .update(accountId)
    .update("\0")
    .update(senderOpenId)
    .digest("hex")
    .slice(0, 32);
  return `feishu-${accountId.slice(0, 12)}-${identityDigest}`;
}

/**
 * Refresh an existing DM binding or create its dynamic agent when current
 * account policy permits config writes.
 */
export async function maybeCreateDynamicAgent(params: {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  accountId: string;
  senderOpenId: string;
  canCreateForConfig: (cfg: OpenClawConfig) => Promise<boolean>;
  log: (msg: string) => void;
}): Promise<MaybeCreateDynamicAgentResult> {
  const { cfg, runtime, senderOpenId, canCreateForConfig, log } = params;
  const accountId = normalizeAccountId(params.accountId);

  if (!hasDefaultDirectRoute(cfg, accountId, senderOpenId)) {
    return { created: false, updatedCfg: cfg };
  }

  const currentCfg = runtime.config.current() as OpenClawConfig;
  if (!hasDefaultDirectRoute(currentCfg, accountId, senderOpenId)) {
    return { created: false, updatedCfg: currentCfg };
  }

  const currentDynamicCfg = resolveDynamicAgentConfig(currentCfg, accountId);
  if (!currentDynamicCfg?.enabled) {
    return { created: false, updatedCfg: currentCfg };
  }
  if (!resolveChannelConfigWrites({ cfg: currentCfg, channelId: "feishu", accountId })) {
    log(`feishu: config writes disabled, not creating agent for ${senderOpenId}`);
    return { created: false, updatedCfg: currentCfg };
  }
  const agentId = resolveDynamicAgentId(accountId, senderOpenId);
  const currentAgentExists = (currentCfg.agents?.list ?? []).some((agent) => agent.id === agentId);
  // Legacy unscoped agents are indistinguishable from valid default-account state.
  // Keep maxAgents as a hard cap instead of auto-rebinding or deleting ambiguous user data.
  if (!currentAgentExists && isAtDynamicAgentLimit(currentCfg, currentDynamicCfg)) {
    log(
      `feishu: maxAgents limit (${currentDynamicCfg.maxAgents}) reached, not creating agent for ${senderOpenId}`,
    );
    return { created: false, updatedCfg: currentCfg };
  }
  if (!(await canCreateForConfig(currentCfg))) {
    return { created: false, updatedCfg: currentCfg };
  }

  // The config mutation lock owns the final duplicate/limit checks. This keeps
  // simultaneous DM creations and policy updates from producing stale writes.
  let skippedCfg: OpenClawConfig | undefined;
  const committed = await runtime.config
    .mutateConfigFile<DynamicAgentMutationResult>({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate: async (draft) => {
        if (!hasDefaultDirectRoute(draft, accountId, senderOpenId)) {
          throw new DynamicAgentMutationSkipped(draft);
        }

        const dynamicCfg = resolveDynamicAgentConfig(draft, accountId);
        if (
          !dynamicCfg?.enabled ||
          !resolveChannelConfigWrites({ cfg: draft, channelId: "feishu", accountId })
        ) {
          throw new DynamicAgentMutationSkipped(draft);
        }
        const agentExists = (draft.agents?.list ?? []).some((agent) => agent.id === agentId);
        if (!agentExists && isAtDynamicAgentLimit(draft, dynamicCfg)) {
          log(
            `feishu: maxAgents limit (${dynamicCfg.maxAgents}) reached, not creating agent for ${senderOpenId}`,
          );
          throw new DynamicAgentMutationSkipped(draft);
        }
        if (!(await canCreateForConfig(draft))) {
          throw new DynamicAgentMutationSkipped(draft);
        }

        if (!agentExists) {
          const workspaceTemplate =
            dynamicCfg.workspaceTemplate ?? "~/.openclaw/workspace-{agentId}";
          const agentDirTemplate =
            dynamicCfg.agentDirTemplate ?? "~/.openclaw/agents/{agentId}/agent";
          const workspace = resolveUserPath(
            workspaceTemplate.replace("{userId}", senderOpenId).replace("{agentId}", agentId),
          );
          const agentDir = resolveUserPath(
            agentDirTemplate.replace("{userId}", senderOpenId).replace("{agentId}", agentId),
          );
          log(`feishu: creating dynamic agent "${agentId}" for user ${senderOpenId}`);
          log(`  workspace: ${workspace}`);
          log(`  agentDir: ${agentDir}`);
          await fs.promises.mkdir(workspace, { recursive: true });
          await fs.promises.mkdir(agentDir, { recursive: true });
          draft.agents = {
            ...draft.agents,
            list: [...(draft.agents?.list ?? []), { id: agentId, workspace, agentDir }],
          };
        } else {
          log(`feishu: agent "${agentId}" exists, adding missing binding for ${senderOpenId}`);
        }

        draft.bindings = [
          ...(draft.bindings ?? []),
          {
            agentId,
            match: {
              channel: "feishu",
              accountId,
              peer: { kind: "direct", id: senderOpenId },
            },
          },
        ];
        return { created: true, agentId };
      },
    })
    .catch((error: unknown) => {
      if (error instanceof DynamicAgentMutationSkipped) {
        skippedCfg = error.cfg;
        return null;
      }
      throw error;
    });
  if (!committed) {
    return { created: false, updatedCfg: skippedCfg ?? currentCfg };
  }

  return {
    created: committed.result?.created ?? false,
    updatedCfg: runtime.config.current() as OpenClawConfig,
    agentId: committed.result?.agentId,
  };
}

/**
 * Resolve a path that may start with ~ to the user's home directory.
 */
function resolveUserPath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
