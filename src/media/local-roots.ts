import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveConfigDir } from "../utils.js";

type BuildMediaLocalRootsOptions = {
  preferredTmpDir?: string;
};

let cachedPreferredTmpDir: string | undefined;

function resolveCachedPreferredTmpDir(): string {
  if (!cachedPreferredTmpDir) {
    cachedPreferredTmpDir = resolvePreferredOpenClawTmpDir();
  }
  return cachedPreferredTmpDir;
}

export function buildMediaLocalRoots(
  stateDir: string,
  configDir: string,
  options: BuildMediaLocalRootsOptions = {},
): string[] {
  const resolvedStateDir = path.resolve(stateDir);
  const resolvedConfigDir = path.resolve(configDir);
  const preferredTmpDir = options.preferredTmpDir ?? resolveCachedPreferredTmpDir();
  return Array.from(
    new Set([
      preferredTmpDir,
      path.join(resolvedStateDir, "media"),
      path.join(resolvedStateDir, "workspace"),
      path.join(resolvedStateDir, "sandboxes"),
      // Upgraded installs can still resolve the active state dir to the legacy
      // ~/.clawdbot tree while new media writes already go under ~/.openclaw/media.
      // Keep inbound media readable across that split without widening roots beyond
      // the managed media cache.
      path.join(resolvedConfigDir, "media"),
    ]),
  );
}

export function getDefaultMediaLocalRoots(): readonly string[] {
  return buildMediaLocalRoots(resolveStateDir(), resolveConfigDir());
}

export function getAgentScopedMediaLocalRoots(
  cfg: OpenClawConfig,
  agentId?: string,
): readonly string[] {
  const roots = buildMediaLocalRoots(resolveStateDir(), resolveConfigDir());
  const normalizedAgentId = normalizeOptionalString(agentId);
  if (!normalizedAgentId) {
    return roots;
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, normalizedAgentId);
  if (!workspaceDir) {
    return roots;
  }
  const normalizedWorkspaceDir = path.resolve(workspaceDir);
  if (!roots.includes(normalizedWorkspaceDir)) {
    roots.push(normalizedWorkspaceDir);
  }
  return roots;
}

/**
 * @deprecated Kept for plugin-sdk compatibility. Media sources no longer widen allowed roots.
 */
export function appendLocalMediaParentRoots(
  roots: readonly string[],
  _mediaSources?: readonly string[],
): string[] {
  return Array.from(new Set(roots.map((root) => path.resolve(root))));
}

export function getAgentScopedMediaLocalRootsForSources({
  cfg,
  agentId,
  mediaSources: _mediaSources,
}: {
  cfg: OpenClawConfig;
  agentId?: string;
  mediaSources?: readonly string[];
}): readonly string[] {
  return getAgentScopedMediaLocalRoots(cfg, agentId);
}
