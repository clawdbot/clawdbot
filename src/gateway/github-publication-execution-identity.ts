import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import {
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
} from "./github-publication-availability.js";
import { matchesGitHubPublicationIdentityRow } from "./github-publication-store.js";

export class GitHubPublicationAuthorityLostError extends Error {}

export type GitHubPublicationIdentityOwner = {
  prepare: () => Promise<PreparedGitHubPublicationIdentity>;
  isCurrent: (identity: PreparedGitHubPublicationIdentity) => boolean;
};

/** Credentials are a fixed snapshot; live workspace, action, and execution owners authorize use. */
export function createGitHubPublicationExecutionIdentity(params: {
  row: Parameters<typeof matchesGitHubPublicationIdentityRow>[0];
  identity?: GitHubPublicationIdentityOwner;
  validateAuthority: () => boolean;
  assertWorkspace: () => void;
}) {
  let active: PreparedGitHubPublicationIdentity | undefined;
  const assertCurrent = () => {
    if (!params.validateAuthority()) {
      throw new GitHubPublicationAuthorityLostError(
        "GitHub publication session authority changed.",
      );
    }
    params.assertWorkspace();
    if (
      active &&
      !(params.identity
        ? params.identity.isCurrent(active)
        : matchesCurrentGitHubPublicationIdentity({
            agentId: params.row.agent_id,
            identity: active,
          }))
    ) {
      throw new Error("GitHub publication identity changed.");
    }
  };
  return {
    assertCurrent,
    refreshIdentity: async (): Promise<PreparedGitHubPublicationIdentity> => {
      assertCurrent();
      const identity = await (params.identity?.prepare() ??
        prepareCurrentGitHubPublicationIdentity(params.row.agent_id));
      assertCurrent();
      if (!matchesGitHubPublicationIdentityRow(params.row, identity)) {
        throw new Error("GitHub publication identity changed.");
      }
      active = identity;
      assertCurrent();
      return identity;
    },
  };
}
