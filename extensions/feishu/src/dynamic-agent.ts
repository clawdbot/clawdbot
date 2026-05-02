import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import type { DynamicAgentCreationConfig } from "./types.js";

type MaybeCreateDynamicAgentResult = {
  created: boolean;
  updatedCfg: OpenClawConfig;
  agentId?: string;
};

/**
 * Check if a dynamic agent should be created for a DM user and create it if needed.
 * This creates a unique agent instance with its own workspace for each DM user.
 */
export async function maybeCreateDynamicAgent(params: {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  senderOpenId: string;
  dynamicCfg: DynamicAgentCreationConfig;
  log: (msg: string) => void;
}): Promise<MaybeCreateDynamicAgentResult> {
  const { cfg, runtime, senderOpenId, dynamicCfg, log } = params;

  // Check if there's already a binding for this user
  const existingBindings = cfg.bindings ?? [];
  const hasBinding = existingBindings.some(
    (b) =>
      b.match?.channel === "feishu" &&
      b.match?.peer?.kind === "direct" &&
      b.match?.peer?.id === senderOpenId,
  );

  if (hasBinding) {
    return { created: false, updatedCfg: cfg };
  }

  // Check maxAgents limit if configured
  if (dynamicCfg.maxAgents !== undefined) {
    const feishuAgentCount = (cfg.agents?.list ?? []).filter((a) =>
      a.id.startsWith("feishu-"),
    ).length;
    if (feishuAgentCount >= dynamicCfg.maxAgents) {
      log(
        `feishu: maxAgents limit (${dynamicCfg.maxAgents}) reached, not creating agent for ${senderOpenId}`,
      );
      return { created: false, updatedCfg: cfg };
    }
  }

  // Use full OpenID as agent ID suffix (OpenID format: ou_xxx is already filesystem-safe)
  const agentId = `feishu-${senderOpenId}`;

  // Check if agent already exists (but binding was missing)
  const existingAgent = (cfg.agents?.list ?? []).find((a) => a.id === agentId);
  if (existingAgent) {
    // Agent exists but binding doesn't - just add the binding
    log(`feishu: agent "${agentId}" exists, adding missing binding for ${senderOpenId}`);

    const updatedCfg: OpenClawConfig = {
      ...cfg,
      bindings: [
        ...existingBindings,
        {
          agentId,
          match: {
            channel: "feishu",
            peer: { kind: "direct", id: senderOpenId },
          },
        },
      ],
    };

    await runtime.config.replaceConfigFile({
      nextConfig: updatedCfg,
      afterWrite: { mode: "auto" },
    });
    return { created: true, updatedCfg, agentId };
  }

  // Resolve path templates with substitutions
  const workspaceTemplate = dynamicCfg.workspaceTemplate ?? "~/.openclaw/workspace-{agentId}";
  const agentDirTemplate = dynamicCfg.agentDirTemplate ?? "~/.openclaw/agents/{agentId}/agent";

  const workspace = resolveUserPath(
    workspaceTemplate.replace("{userId}", senderOpenId).replace("{agentId}", agentId),
  );
  const agentDir = resolveUserPath(
    agentDirTemplate.replace("{userId}", senderOpenId).replace("{agentId}", agentId),
  );

  log(`feishu: creating dynamic agent "${agentId}" for user ${senderOpenId}`);
  log(`  workspace: ${workspace}`);
  log(`  agentDir: ${agentDir}`);

  // Create directories
  await fs.promises.mkdir(workspace, { recursive: true });
  await fs.promises.mkdir(agentDir, { recursive: true });

  // Update configuration with new agent and binding
  const updatedCfg: OpenClawConfig = {
    ...cfg,
    agents: {
      ...cfg.agents,
      list: [...(cfg.agents?.list ?? []), { id: agentId, workspace, agentDir }],
    },
    bindings: [
      ...existingBindings,
      {
        agentId,
        match: {
          channel: "feishu",
          peer: { kind: "direct", id: senderOpenId },
        },
      },
    ],
  };

  // Write updated config using PluginRuntime API
  await runtime.config.replaceConfigFile({
    nextConfig: updatedCfg,
    afterWrite: { mode: "auto" },
  });

  return { created: true, updatedCfg, agentId };
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
