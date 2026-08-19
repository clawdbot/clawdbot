import { isDeepStrictEqual } from "node:util";
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

      let entry = resolveMutableAgentEntry(draft, params.agentId);
      if (
        params.expectedIdentity !== undefined &&
        !sameIdentity(entry?.tools?.github, params.expectedIdentity)
      ) {
        throw new Error("GitHub identity changed while setup was in progress.");
      }
      if (!entry && params.identity) {
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
