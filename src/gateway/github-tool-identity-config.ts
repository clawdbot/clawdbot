import { isDeepStrictEqual } from "node:util";
import {
  matchesAgentLifecycleBinding,
  type AgentLifecycleBinding,
} from "../agents/agent-lifecycle-registry.js";
import { resolveMutableAgentEntry } from "../agents/agent-scope.js";
import { applyAgentConfig } from "../commands/agents.config.js";
import { unsetConfigValueAtPath } from "../config/config-paths.js";
import { mutateConfigFileWithRetry } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";

function sameIdentity(
  left: GitHubToolIdentityConfig | undefined,
  right: GitHubToolIdentityConfig | null,
): boolean {
  return isDeepStrictEqual(left ?? null, right);
}

export async function updateGitHubToolIdentityConfig(params: {
  scope: "system" | "agent";
  agentId: string;
  identity?: GitHubToolIdentityConfig;
  expectedIdentity?: GitHubToolIdentityConfig | null;
  agentLifecycleBinding?: AgentLifecycleBinding;
}): Promise<OpenClawConfig> {
  const mutation = await mutateConfigFileWithRetry({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      if (params.scope === "system") {
        if (
          params.expectedIdentity !== undefined &&
          !sameIdentity(draft.tools?.github, params.expectedIdentity)
        ) {
          throw new Error("GitHub identity changed while setup was in progress.");
        }
        draft.tools ??= {};
        if (params.identity) {
          draft.tools.github = params.identity;
        } else {
          unsetConfigValueAtPath(draft, ["tools", "github"]);
        }
        return;
      }

      if (
        params.agentLifecycleBinding &&
        !matchesAgentLifecycleBinding(draft, params.agentLifecycleBinding)
      ) {
        throw new Error("Agent changed while GitHub setup was in progress.");
      }
      let entry = resolveMutableAgentEntry(draft, params.agentId);
      if (params.agentLifecycleBinding && !entry) {
        throw new Error("Agent changed while GitHub setup was in progress.");
      }
      if (
        params.expectedIdentity !== undefined &&
        !sameIdentity(entry?.tools?.github, params.expectedIdentity)
      ) {
        throw new Error("GitHub identity changed while setup was in progress.");
      }
      if (!entry && params.identity && !params.agentLifecycleBinding) {
        Object.assign(draft, applyAgentConfig(draft, { agentId: params.agentId }));
        entry = resolveMutableAgentEntry(draft, params.agentId);
      }
      if (!entry) {
        return;
      }
      entry.tools ??= {};
      if (params.identity) {
        entry.tools.github = params.identity;
      } else {
        unsetConfigValueAtPath(entry, ["tools", "github"]);
      }
    },
  });
  return mutation.nextConfig;
}
