import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateToolsGitHubConfigureParams,
  validateToolsGitHubStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  createManagedGitHubProfileId,
  installManagedGitHubProfile,
  resolveConfiguredGitHubToolIdentity,
  resolveGitHubToolIdentityStatus,
  resolveManagedGitHubProfileDir,
} from "../../agents/github-tool-identity.js";
import { consumeGitHubSetupHandoff } from "../../secrets/store/secret-store.js";
import { updateGitHubToolIdentityConfig } from "../github-tool-identity-config.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const toolsGitHubHandlers: GatewayRequestHandlers = {
  "tools.github.status": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateToolsGitHubStatusParams, "tools.github.status", respond)
    ) {
      return;
    }
    const resolved = resolveAgentIdOrRespondError({
      rawAgentId: params.agentId,
      respond,
      cfg: context.getRuntimeConfig(),
      normalize: normalizeOptionalString,
    });
    if (!resolved) {
      return;
    }
    respond(
      true,
      await resolveGitHubToolIdentityStatus({
        config: resolved.cfg,
        agentId: resolved.agentId,
      }),
    );
  },
  "tools.github.configure": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateToolsGitHubConfigureParams,
        "tools.github.configure",
        respond,
      )
    ) {
      return;
    }
    const resolved = resolveAgentIdOrRespondError({
      rawAgentId: params.agentId,
      respond,
      cfg: context.getRuntimeConfig(),
      normalize: normalizeOptionalString,
    });
    if (!resolved) {
      return;
    }
    try {
      const previousIdentity = resolveConfiguredGitHubToolIdentity({
        config: resolved.cfg,
        agentId: resolved.agentId,
        scope: params.scope,
      });
      if (params.mode === "inherit") {
        const nextConfig = await updateGitHubToolIdentityConfig({
          scope: params.scope,
          agentId: resolved.agentId,
          expectedIdentity: previousIdentity ?? null,
        });
        respond(
          true,
          await resolveGitHubToolIdentityStatus({
            config: nextConfig,
            agentId: resolved.agentId,
          }),
        );
        return;
      }

      const gitAuthor = params.gitAuthor
        ? {
            ...(params.gitAuthor.name !== undefined ? { name: params.gitAuthor.name.trim() } : {}),
            ...(params.gitAuthor.email !== undefined
              ? { email: params.gitAuthor.email.trim() }
              : {}),
          }
        : undefined;
      const token = consumeGitHubSetupHandoff({ name: params.secretName });
      if (!token) {
        throw new Error("temporary GitHub credential is unavailable");
      }
      const profileId = createManagedGitHubProfileId();
      const identity = {
        profileId,
        ...(gitAuthor ? { gitAuthor } : {}),
      };
      const profileDir = resolveManagedGitHubProfileDir({
        agentId: resolved.agentId,
        scope: params.scope,
        profileId,
      });
      let nextConfig = resolved.cfg;
      await installManagedGitHubProfile({
        profileDir,
        token,
        commitConfig: async () => {
          nextConfig = await updateGitHubToolIdentityConfig({
            scope: params.scope,
            agentId: resolved.agentId,
            identity,
            expectedIdentity: previousIdentity ?? null,
          });
        },
      });
      respond(
        true,
        await resolveGitHubToolIdentityStatus({
          config: nextConfig,
          agentId: resolved.agentId,
        }),
      );
    } catch {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "GitHub identity setup failed"));
    }
  },
};
