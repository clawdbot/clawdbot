/**
 * System prompt runtime parameter resolver.
 *
 * Collects repository, time, timezone, channel, and shell facts for prompt rendering.
 */
import fs from "node:fs";
import path from "node:path";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ChatType } from "../channels/chat-type.js";
import { resolveControlUiSessionUrl } from "../config/control-ui-link-base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  formatActiveNodeContextLabel,
  getCurrentActiveNodeContext,
} from "../infra/active-node-context.js";
import { findGitRoot } from "../infra/git-root.js";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import { formatDateStamp, resolveUserTimezone } from "./date-time.js";
import { resolveAgentIdentity } from "./identity.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

const MAX_RUNTIME_AGENT_NAME_CHARS = 128;
const MAX_RUNTIME_SESSION_URL_CHARS = 512;

type RuntimeInfoInput = {
  agentId?: string;
  agentName?: string;
  sessionKey?: string;
  sessionId?: string;
  sessionUrl?: string;
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
  repoRoot?: string;
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
  runtime: Omit<RuntimeInfoInput, "agentId" | "agentName" | "sessionUrl">;
  workspaceDir?: string;
  cwd?: string;
  preparedRepoRoot?: string | null;
}): SystemPromptRuntimeParams {
  const repoRoot = Object.hasOwn(params, "preparedRepoRoot")
    ? (params.preparedRepoRoot ?? undefined)
    : resolveSystemPromptRepoRoot(params);
  const userTimezone = resolveUserTimezone(params.config?.agents?.defaults?.userTimezone);
  const userDate = formatDateStamp(Date.now(), userTimezone);
  const { runId } = parseCronRunScopeSuffix(params.runtime.sessionKey);
  // Exact isolated-cron URLs expose a volatile run id before prompt rendering can normalize it,
  // defeating byte-identical prompt-prefix reuse across runs of the same job.
  const sessionUrl =
    runId === undefined
      ? resolveControlUiSessionUrl(params.config, {
          sessionKey: params.runtime.sessionKey,
          fallbackAgentId: params.agentId,
          exactKey: true,
        })
      : undefined;
  return {
    runtimeInfo: {
      agentId: params.agentId,
      agentName:
        params.config && params.agentId
          ? resolveRuntimeAgentName(params.config, params.agentId)
          : undefined,
      ...params.runtime,
      // Published links must be externally usable and bounded before entering model context.
      sessionUrl:
        sessionUrl?.startsWith("https://") && sessionUrl.length <= MAX_RUNTIME_SESSION_URL_CHARS
          ? sessionUrl
          : undefined,
      activeNode:
        formatActiveNodeContextLabel(getCurrentActiveNodeContext()) ?? params.runtime.activeNode,
      repoRoot,
    },
    userTimezone,
    userDate,
  };
}

export function resolveRuntimeAgentName(config: OpenClawConfig, agentId: string) {
  const name = sanitizeForPromptLiteral(resolveAgentIdentity(config, agentId)?.name ?? "").trim();
  const bounded = truncateUtf16Safe(name, MAX_RUNTIME_AGENT_NAME_CHARS).trimEnd();
  return bounded && bounded !== agentId ? bounded : undefined;
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
