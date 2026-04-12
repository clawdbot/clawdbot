import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { findGitRoot } from "../infra/git-root.js";
import { resolveHomeRelativePath } from "../infra/home-dir.js";
import {
  formatUserTime,
  resolveUserTimeFormat,
  resolveUserTimezone,
  type ResolvedTimeFormat,
} from "./date-time.js";

export type RuntimeInfoInput = {
  agentId?: string;
  host: string;
  os: string;
  arch: string;
  node: string;
  model: string;
  defaultModel?: string;
  shell?: string;
  channel?: string;
  capabilities?: string[];
  /** Supported message actions for the current channel (e.g., react, edit, unsend) */
  channelActions?: string[];
  repoRoot?: string;
  canvasRootDir?: string;
};

export type SystemPromptRuntimeParams = {
  runtimeInfo: RuntimeInfoInput;
  userTimezone: string;
  userTime?: string;
  userTimeFormat?: ResolvedTimeFormat;
};

export function buildSystemPromptParams(params: {
  config?: OpenClawConfig;
  agentId?: string;
  runtime: Omit<RuntimeInfoInput, "agentId">;
  workspaceDir?: string;
  cwd?: string;
}): SystemPromptRuntimeParams {
  const repoRoot = resolveRepoRoot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
  });
  const userTimezone = resolveUserTimezone(params.config?.agents?.defaults?.userTimezone);
  const userTimeFormat = resolveUserTimeFormat(params.config?.agents?.defaults?.timeFormat);
  const userTime = formatUserTime(new Date(), userTimezone, userTimeFormat);
  const stateDir = resolveStateDir(process.env);
  const canvasRootDir = resolveCanvasRootDir({
    config: params.config,
    stateDir,
  });
  return {
    runtimeInfo: {
      agentId: params.agentId,
      ...params.runtime,
      repoRoot,
      canvasRootDir,
    },
    userTimezone,
    userTime,
    userTimeFormat,
  };
}

function resolveCanvasRootDir(params: { config?: OpenClawConfig; stateDir: string }): string {
  const configured = params.config?.canvasHost?.root?.trim();
  if (configured) {
    return path.resolve(
      resolveHomeRelativePath(configured, {
        env: process.env,
      }),
    );
  }
  return path.resolve(path.join(params.stateDir, "canvas"));
}

function resolveRepoRoot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  cwd?: string;
}): string | undefined {
  const configured = params.config?.agents?.defaults?.repoRoot?.trim();
  if (configured) {
    try {
      const resolved = path.resolve(configured);
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        return resolved;
      }
    } catch {
      // ignore invalid config path
    }
  }
  const candidates = [params.workspaceDir, params.cwd]
    .map((value) => value?.trim())
    .filter(Boolean) as string[];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    const root = findGitRoot(resolved);
    if (root) {
      return root;
    }
  }
  return undefined;
}
