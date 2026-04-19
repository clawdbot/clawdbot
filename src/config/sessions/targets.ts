import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  resolveAgentSessionDirsFromAgentsDir,
  resolveAgentSessionDirsFromAgentsDirSync,
} from "../../agents/session-dirs.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { resolveStateDir } from "../paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAgentsDirFromSessionStorePath, resolveStorePath } from "./paths.js";

export type SessionStoreSelectionOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
};

export type SessionStoreTarget = {
  agentId: string;
  storePath: string;
};

const NON_FATAL_DISCOVERY_ERROR_CODES = new Set([
  "EACCES",
  "ELOOP",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
  "ESTALE",
]);

function dedupeTargetsByStorePath(targets: SessionStoreTarget[]): SessionStoreTarget[] {
  const deduped = new Map<string, SessionStoreTarget>();
  for (const target of targets) {
    if (!deduped.has(target.storePath)) {
      deduped.set(target.storePath, target);
    }
  }
  return [...deduped.values()];
}

function shouldSkipDiscoveryError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && NON_FATAL_DISCOVERY_ERROR_CODES.has(code);
}

function isWithinRoot(realPath: string, realRoot: string): boolean {
  return realPath === realRoot || realPath.startsWith(`${realRoot}${path.sep}`);
}

function shouldSkipDiscoveredAgentDirName(dirName: string, agentId: string): boolean {
  // Avoid collapsing arbitrary directory names like "###" into the default main agent.
  // Human-friendly names like "Retired Agent" are still allowed because they normalize to
  // a non-default stable id and preserve the intended retired-store discovery behavior.
  return (
    agentId === DEFAULT_AGENT_ID && normalizeLowercaseStringOrEmpty(dirName) !== DEFAULT_AGENT_ID
  );
}

function resolveValidatedDiscoveredStorePathSync(params: {
  sessionsDir: string;
  agentsRoot: string;
  realAgentsRoot?: string;
}): string | undefined {
  const storePath = path.join(params.sessionsDir, "sessions.json");
  try {
    const stat = fsSync.lstatSync(storePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return undefined;
    }
    const realStorePath = fsSync.realpathSync.native(storePath);
    const realAgentsRoot = params.realAgentsRoot ?? fsSync.realpathSync.native(params.agentsRoot);
    return isWithinRoot(realStorePath, realAgentsRoot) ? realStorePath : undefined;
  } catch (err) {
    if (shouldSkipDiscoveryError(err)) {
      return undefined;
    }
    throw err;
  }
}

async function resolveValidatedDiscoveredStorePath(params: {
  sessionsDir: string;
  agentsRoot: string;
  realAgentsRoot?: string;
}): Promise<string | undefined> {
  const storePath = path.join(params.sessionsDir, "sessions.json");
  try {
    const stat = await fs.lstat(storePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return undefined;
    }
    const realStorePath = await fs.realpath(storePath);
    const realAgentsRoot = params.realAgentsRoot ?? (await fs.realpath(params.agentsRoot));
    return isWithinRoot(realStorePath, realAgentsRoot) ? realStorePath : undefined;
  } catch (err) {
    if (shouldSkipDiscoveryError(err)) {
      return undefined;
    }
    throw err;
  }
}

function resolveSessionStoreDiscoveryState(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): {
  configuredTargets: SessionStoreTarget[];
  agentsRoots: string[];
} {
  const configuredTargets = resolveSessionStoreTargets(cfg, { allAgents: true }, { env });
  const agentsRoots = new Set<string>();
  for (const target of configuredTargets) {
    const agentsDir = resolveAgentsDirFromSessionStorePath(target.storePath);
    if (agentsDir) {
      agentsRoots.add(agentsDir);
    }
  }
  agentsRoots.add(path.join(resolveStateDir(env), "agents"));
  return {
    configuredTargets,
    agentsRoots: [...agentsRoots],
  };
}

function toDiscoveredSessionStoreTarget(
  sessionsDir: string,
  storePath: string,
): SessionStoreTarget | undefined {
  const dirName = path.basename(path.dirname(sessionsDir));
  const agentId = normalizeAgentId(dirName);
  if (shouldSkipDiscoveredAgentDirName(dirName, agentId)) {
    return undefined;
  }
  return {
    agentId,
    // Keep the actual on-disk store path so retired/manual agent dirs remain discoverable
    // even if their directory name no longer round-trips through normalizeAgentId().
    storePath,
  };
}

export function resolveAllAgentSessionStoreTargetsSync(
  cfg: OpenClawConfig,
  params: { env?: NodeJS.ProcessEnv } = {},
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const { configuredTargets, agentsRoots } = resolveSessionStoreDiscoveryState(cfg, env);
  const realAgentsRoots = new Map<string, string>();
  const getRealAgentsRoot = (agentsRoot: string): string | undefined => {
    const cached = realAgentsRoots.get(agentsRoot);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const realAgentsRoot = fsSync.realpathSync.native(agentsRoot);
      realAgentsRoots.set(agentsRoot, realAgentsRoot);
      return realAgentsRoot;
    } catch (err) {
      if (shouldSkipDiscoveryError(err)) {
        return undefined;
      }
      throw err;
    }
  };
  const validatedConfiguredTargets = configuredTargets.flatMap((target) => {
    const agentsRoot = resolveAgentsDirFromSessionStorePath(target.storePath);
    if (!agentsRoot) {
      return [target];
    }
    const realAgentsRoot = getRealAgentsRoot(agentsRoot);
    if (!realAgentsRoot) {
      return [];
    }
    const validatedStorePath = resolveValidatedDiscoveredStorePathSync({
      sessionsDir: path.dirname(target.storePath),
      agentsRoot,
      realAgentsRoot,
    });
    return validatedStorePath ? [{ ...target, storePath: validatedStorePath }] : [];
  });
  const discoveredTargets = agentsRoots.flatMap((agentsDir) => {
    try {
      const realAgentsRoot = getRealAgentsRoot(agentsDir);
      if (!realAgentsRoot) {
        return [];
      }
      return resolveAgentSessionDirsFromAgentsDirSync(agentsDir).flatMap((sessionsDir) => {
        const validatedStorePath = resolveValidatedDiscoveredStorePathSync({
          sessionsDir,
          agentsRoot: agentsDir,
          realAgentsRoot,
        });
        const target = validatedStorePath
          ? toDiscoveredSessionStoreTarget(sessionsDir, validatedStorePath)
          : undefined;
        return target ? [target] : [];
      });
    } catch (err) {
      if (shouldSkipDiscoveryError(err)) {
        return [];
      }
      throw err;
    }
  });
  return dedupeTargetsByStorePath([...validatedConfiguredTargets, ...discoveredTargets]);
}

export async function resolveAllAgentSessionStoreTargets(
  cfg: OpenClawConfig,
  params: { env?: NodeJS.ProcessEnv } = {},
): Promise<SessionStoreTarget[]> {
  const env = params.env ?? process.env;
  const { configuredTargets, agentsRoots } = resolveSessionStoreDiscoveryState(cfg, env);
  const realAgentsRoots = new Map<string, string>();
  const getRealAgentsRoot = async (agentsRoot: string): Promise<string | undefined> => {
    const cached = realAgentsRoots.get(agentsRoot);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const realAgentsRoot = await fs.realpath(agentsRoot);
      realAgentsRoots.set(agentsRoot, realAgentsRoot);
      return realAgentsRoot;
    } catch (err) {
      if (shouldSkipDiscoveryError(err)) {
        return undefined;
      }
      throw err;
    }
  };
  const validatedConfiguredTargets = (
    await Promise.all(
      configuredTargets.map(async (target) => {
        const agentsRoot = resolveAgentsDirFromSessionStorePath(target.storePath);
        if (!agentsRoot) {
          return target;
        }
        const realAgentsRoot = await getRealAgentsRoot(agentsRoot);
        if (!realAgentsRoot) {
          return undefined;
        }
        const validatedStorePath = await resolveValidatedDiscoveredStorePath({
          sessionsDir: path.dirname(target.storePath),
          agentsRoot,
          realAgentsRoot,
        });
        return validatedStorePath
          ? Object.assign({}, target, { storePath: validatedStorePath })
          : undefined;
      }),
    )
  ).filter((target): target is SessionStoreTarget => Boolean(target));

  const discoveredTargets = (
    await Promise.all(
      agentsRoots.map(async (agentsDir) => {
        try {
          const realAgentsRoot = await getRealAgentsRoot(agentsDir);
          if (!realAgentsRoot) {
            return [];
          }
          const sessionsDirs = await resolveAgentSessionDirsFromAgentsDir(agentsDir);
          return (
            await Promise.all(
              sessionsDirs.map(async (sessionsDir) => {
                const validatedStorePath = await resolveValidatedDiscoveredStorePath({
                  sessionsDir,
                  agentsRoot: agentsDir,
                  realAgentsRoot,
                });
                return validatedStorePath
                  ? toDiscoveredSessionStoreTarget(sessionsDir, validatedStorePath)
                  : undefined;
              }),
            )
          ).filter((target): target is SessionStoreTarget => Boolean(target));
        } catch (err) {
          if (shouldSkipDiscoveryError(err)) {
            return [];
          }
          throw err;
        }
      }),
    )
  ).flat();

  return dedupeTargetsByStorePath([...validatedConfiguredTargets, ...discoveredTargets]);
}

export function resolveSessionStoreTargets(
  cfg: OpenClawConfig,
  opts: SessionStoreSelectionOptions,
  params: { env?: NodeJS.ProcessEnv } = {},
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const hasAgent = Boolean(opts.agent?.trim());
  const allAgents = opts.allAgents === true;
  if (hasAgent && allAgents) {
    throw new Error("--agent and --all-agents cannot be used together");
  }
  if (opts.store && (hasAgent || allAgents)) {
    throw new Error("--store cannot be combined with --agent or --all-agents");
  }

  if (opts.store) {
    return [
      {
        agentId: defaultAgentId,
        storePath: resolveStorePath(opts.store, { agentId: defaultAgentId, env }),
      },
    ];
  }

  if (allAgents) {
    const targets = listAgentIds(cfg).map((agentId) => ({
      agentId,
      storePath: resolveStorePath(cfg.session?.store, { agentId, env }),
    }));
    return dedupeTargetsByStorePath(targets);
  }

  if (hasAgent) {
    const knownAgents = listAgentIds(cfg);
    const requested = normalizeAgentId(opts.agent ?? "");
    if (!knownAgents.includes(requested)) {
      throw new Error(
        `Unknown agent id "${opts.agent}". Use "openclaw agents list" to see configured agents.`,
      );
    }
    return [
      {
        agentId: requested,
        storePath: resolveStorePath(cfg.session?.store, { agentId: requested, env }),
      },
    ];
  }

  return [
    {
      agentId: defaultAgentId,
      storePath: resolveStorePath(cfg.session?.store, { agentId: defaultAgentId, env }),
    },
  ];
}
