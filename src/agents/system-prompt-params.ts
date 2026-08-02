/**
 * System prompt runtime parameter resolver.
 *
 * Collects repository, time, timezone, channel, shell, and active-process facts for prompt rendering.
 */
import fs from "node:fs";
import path from "node:path";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { ChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  formatActiveNodeContextLabel,
  getCurrentActiveNodeContext,
} from "../infra/active-node-context.js";
import { findGitRoot } from "../infra/git-root.js";
import type { ActiveProcessSessionReference } from "./bash-process-references.js";
import { formatDateStamp, resolveUserTimezone } from "./date-time.js";

type RuntimeInfoInput = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  host: string;
  os: string;
  arch: string;
  node: string;
  model: string;
  defaultModel?: string;
  shell?: string;
  channel?: string;
  chatType?: ChatType;
  capabilities?: string[];
  /** Supported message actions for the current channel (e.g., react, edit, unsend) */
  channelActions?: string[];
  repoRoot?: string;
  activeProcessSessions?: ActiveProcessSessionReference[];
  activeNode?: string;
};

type SystemPromptRuntimeParams = {
  runtimeInfo: RuntimeInfoInput;
  userTimezone: string;
  userDate: string;
};

export function buildSystemPromptParams(params: {
  config?: OpenClawConfig;
  agentId?: string;
  runtime: Omit<RuntimeInfoInput, "agentId">;
  workspaceDir?: string;
  cwd?: string;
  preparedRepoRoot?: string | null;
}): SystemPromptRuntimeParams {
  const repoRoot = Object.hasOwn(params, "preparedRepoRoot")
    ? (params.preparedRepoRoot ?? undefined)
    : resolveSystemPromptRepoRoot(params);
  const userTimezone = resolveUserTimezone(params.config?.agents?.defaults?.userTimezone);
  const userDate = formatDateStamp(Date.now(), userTimezone);
  return {
    runtimeInfo: {
      agentId: params.agentId,
      ...params.runtime,
      activeNode:
        formatActiveNodeContextLabel(getCurrentActiveNodeContext()) ?? params.runtime.activeNode,
      repoRoot,
    },
    userTimezone,
    userDate,
  };
}

export function resolveSystemPromptRepoRoot(params: {
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
  const candidates = normalizeStringEntries([params.workspaceDir ?? "", params.cwd ?? ""]);
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
