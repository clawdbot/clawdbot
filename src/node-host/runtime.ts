/** Transport-independent CLI node-host runtime shared by Gateway and app workers. */
import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import { getRuntimeConfig } from "../config/config.js";
import type { SkillBinTrustEntry } from "../infra/exec-approvals.js";
import { resolveExecutableFromPathEnv } from "../infra/executable-path.js";
import {
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  NODE_EXEC_APPROVALS_COMMANDS,
  NODE_FS_LIST_DIR_COMMAND,
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_SYSTEM_RUN_COMMANDS,
} from "../infra/node-commands.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import type { NodeHostClient } from "./client.js";
import { handleInvoke, type NodeInvokeRequestPayload, type SkillBinsProvider } from "./invoke.js";
import { startNodeHostMcpManager, type NodeHostMcpManager } from "./mcp.js";
import {
  ensureNodeHostPluginRegistry,
  listRegisteredNodeHostCapsAndCommands,
} from "./plugin-node-host.js";
import { scanNodeHostedSkills } from "./skills.js";

const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

type NodeHostManifest = {
  caps: string[];
  commands: string[];
  pathEnv: string;
};

export type NodeHostInventory = {
  skills: unknown[] | null;
  pluginTools: unknown[];
};

type PreparedNodeHostRuntime = {
  manifest: NodeHostManifest;
  initialInventory: NodeHostInventory;
  start(params: {
    client: NodeHostClient;
    onInventoryChanged?: (inventory: NodeHostInventory) => void;
  }): ActiveNodeHostRuntime;
};

type ActiveNodeHostRuntime = {
  invoke(frame: NodeInvokeRequestPayload): Promise<void>;
  cancel(invokeId: string): void;
  cancelAll(): void;
  close(): Promise<void>;
};

function resolveExecutablePathFromEnv(bin: string, pathEnv: string): string | null {
  if (bin.includes("/") || bin.includes("\\")) {
    return null;
  }
  return resolveExecutableFromPathEnv(bin, pathEnv) ?? null;
}

function resolveExecutableTrustPathFromEnv(bin: string, pathEnv: string): string | null {
  const resolvedPath = resolveExecutablePathFromEnv(bin, pathEnv);
  if (!resolvedPath) {
    return null;
  }
  try {
    return fs.realpathSync(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function resolveSkillBinTrustEntries(bins: string[], pathEnv: string): SkillBinTrustEntry[] {
  const trustEntries: SkillBinTrustEntry[] = [];
  const seen = new Set<string>();
  for (const raw of bins) {
    const name = raw.trim();
    if (!name) {
      continue;
    }
    const resolvedPath = resolveExecutableTrustPathFromEnv(name, pathEnv);
    if (!resolvedPath) {
      continue;
    }
    const key = `${name}\u0000${resolvedPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    trustEntries.push({ name, resolvedPath });
  }
  return trustEntries.toSorted(
    (left, right) =>
      left.name.localeCompare(right.name) || left.resolvedPath.localeCompare(right.resolvedPath),
  );
}

class SkillBinsCache implements SkillBinsProvider {
  private bins: SkillBinTrustEntry[] = [];
  private lastRefresh = 0;
  private readonly ttlMs = 90_000;

  constructor(
    private readonly client: NodeHostClient,
    private readonly pathEnv: string,
  ) {}

  async current(force = false): Promise<SkillBinTrustEntry[]> {
    if (force || Date.now() - this.lastRefresh > this.ttlMs) {
      await this.refresh();
    }
    return this.bins;
  }

  private async refresh() {
    try {
      const res = await this.client.request<{ bins: Array<unknown> }>("skills.bins", {});
      const bins = Array.isArray(res?.bins) ? res.bins.map((bin) => String(bin)) : [];
      this.bins = resolveSkillBinTrustEntries(bins, this.pathEnv);
      this.lastRefresh = Date.now();
    } catch {
      if (!this.lastRefresh) {
        this.bins = [];
      }
    }
  }
}

function ensureNodePathEnv(): string {
  ensureOpenClawCliOnPath({ pathEnv: process.env.PATH ?? "" });
  const current = process.env.PATH ?? "";
  if (current.trim()) {
    return current;
  }
  process.env.PATH = DEFAULT_NODE_PATH;
  return DEFAULT_NODE_PATH;
}

function createInventory(params: {
  skills: unknown[] | null;
  pluginTools: unknown[];
  mcpManager?: NodeHostMcpManager;
}): NodeHostInventory {
  const pluginTools = [...params.pluginTools, ...(params.mcpManager?.descriptors ?? [])].toSorted(
    (left, right) => {
      const a = left as { pluginId?: string; name?: string };
      const b = right as { pluginId?: string; name?: string };
      return (
        (a.pluginId ?? "").localeCompare(b.pluginId ?? "") ||
        (a.name ?? "").localeCompare(b.name ?? "")
      );
    },
  );
  return { skills: params.skills, pluginTools };
}

export async function prepareNodeHostRuntime(params?: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  /** The embedded app worker never advertises native agent runs. */
  enableAgentRuns?: boolean;
}): Promise<PreparedNodeHostRuntime> {
  const config = params?.config ?? getRuntimeConfig();
  const env = params?.env ?? process.env;
  await ensureNodeHostPluginRegistry({ config, env });
  const pluginNodeHost = listRegisteredNodeHostCapsAndCommands({ config, env });
  const pathEnv = ensureNodePathEnv();
  // Opt-in and binary resolution are node-local enforcement points. A Gateway
  // cannot advertise or enable this command on the host's behalf.
  const claudePath =
    params?.enableAgentRuns === true && config.nodeHost?.agentRuns?.claude?.enabled === true
      ? resolveExecutableTrustPathFromEnv("claude", pathEnv)
      : null;
  const skills = config.nodeHost?.skills?.enabled === false ? null : scanNodeHostedSkills();
  const manifest: NodeHostManifest = {
    caps: [...new Set(["system", "mcp", ...pluginNodeHost.caps])].toSorted(),
    commands: [
      ...new Set([
        ...NODE_SYSTEM_RUN_COMMANDS,
        ...NODE_EXEC_APPROVALS_COMMANDS,
        NODE_FS_LIST_DIR_COMMAND,
        NODE_MCP_TOOLS_CALL_COMMAND,
        ...(claudePath ? [NODE_AGENT_CLI_CLAUDE_RUN_COMMAND] : []),
        ...pluginNodeHost.commands,
      ]),
    ].toSorted(),
    pathEnv,
  };
  const initialInventory = createInventory({
    skills,
    pluginTools: pluginNodeHost.nodePluginTools,
  });

  return {
    manifest,
    initialInventory,
    start({ client, onInventoryChanged }) {
      const mcpAbort = new AbortController();
      const skillBins = new SkillBinsCache(client, pathEnv);
      const activeClaudeRuns = new Map<string, AbortController>();
      let manager: NodeHostMcpManager | undefined;
      const startup = startNodeHostMcpManager(config.nodeHost?.mcp?.servers, {
        signal: mcpAbort.signal,
      }).then((resolved) => {
        manager = resolved;
        onInventoryChanged?.(
          createInventory({
            skills,
            pluginTools: pluginNodeHost.nodePluginTools,
            mcpManager: manager,
          }),
        );
        return resolved;
      });
      return {
        async invoke(frame) {
          const controller =
            claudePath && frame.command === NODE_AGENT_CLI_CLAUDE_RUN_COMMAND
              ? new AbortController()
              : undefined;
          if (controller) {
            activeClaudeRuns.set(frame.id, controller);
          }
          try {
            await handleInvoke(frame, client, skillBins, manager, {
              ...(claudePath ? { claudePath } : {}),
              ...(controller ? { signal: controller.signal } : {}),
            });
          } finally {
            if (controller && activeClaudeRuns.get(frame.id) === controller) {
              activeClaudeRuns.delete(frame.id);
            }
          }
        },
        cancel(invokeId) {
          activeClaudeRuns.get(invokeId)?.abort();
        },
        cancelAll() {
          for (const controller of activeClaudeRuns.values()) {
            controller.abort();
          }
          activeClaudeRuns.clear();
        },
        async close() {
          this.cancelAll();
          mcpAbort.abort();
          const resolved = manager ?? (await startup.catch(() => undefined));
          await resolved?.close();
        },
      };
    },
  };
}
