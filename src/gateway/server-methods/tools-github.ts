import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateToolsGitHubAuthorizeCancelParams,
  validateToolsGitHubAuthorizePollParams,
  validateToolsGitHubAuthorizeStartParams,
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
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { consumeGitHubSetupHandoff } from "../../secrets/store/secret-store.js";
import { GitHubCliUnavailableError } from "../github-cli-preflight.js";
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
        sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? resolved.cfg,
        agentId: resolved.agentId,
        selectedScope: params.selectedScope,
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
        if (previousIdentity?.kind === "oauth") {
          context.githubOAuthService?.retireProfile(previousIdentity.profileId);
        }
        respond(
          true,
          await resolveGitHubToolIdentityStatus({
            config: nextConfig,
            agentId: resolved.agentId,
            selectedScope: params.scope,
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
      const profileDir = resolveManagedGitHubProfileDir({
        agentId: resolved.agentId,
        scope: params.scope,
        profileId,
      });
      let nextConfig = resolved.cfg;
      await installManagedGitHubProfile({
        profileDir,
        token,
        commitConfig: async (account) => {
          const identity = {
            profileId,
            gitAuthor: gitAuthor ?? {
              name: account.login,
              email: `${account.accountId}+${account.login}@users.noreply.github.com`,
            },
          };
          nextConfig = await updateGitHubToolIdentityConfig({
            scope: params.scope,
            agentId: resolved.agentId,
            identity,
            expectedIdentity: previousIdentity ?? null,
          });
        },
      });
      if (previousIdentity?.kind === "oauth") {
        context.githubOAuthService?.retireProfile(previousIdentity.profileId);
      }
      respond(
        true,
        await resolveGitHubToolIdentityStatus({
          config: nextConfig,
          agentId: resolved.agentId,
          selectedScope: params.scope,
        }),
      );
    } catch {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "GitHub identity setup failed"));
    }
  },
  "tools.github.authorize.start": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateToolsGitHubAuthorizeStartParams,
        "tools.github.authorize.start",
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
      const service = context.githubOAuthService;
      if (!service) {
        throw new Error("GitHub authorization lifecycle is unavailable.");
      }
      respond(
        true,
        await service.startAuthorization({ scope: params.scope, agentId: resolved.agentId }),
      );
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          error instanceof GitHubCliUnavailableError
            ? error.message
            : "GitHub authorization could not start",
        ),
      );
    }
  },
  "tools.github.authorize.poll": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateToolsGitHubAuthorizePollParams,
        "tools.github.authorize.poll",
        respond,
      )
    ) {
      return;
    }
    try {
      const service = context.githubOAuthService;
      if (!service) {
        throw new Error("GitHub authorization lifecycle is unavailable.");
      }
      respond(true, await service.pollAuthorization(params.requestId));
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "GitHub authorization polling failed"),
      );
    }
  },
  "tools.github.authorize.cancel": ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateToolsGitHubAuthorizeCancelParams,
        "tools.github.authorize.cancel",
        respond,
      )
    ) {
      return;
    }
    const service = context.githubOAuthService;
    if (!service) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "GitHub authorization lifecycle is unavailable"),
      );
      return;
    }
    respond(true, { cancelled: service.cancelAuthorization(params.requestId) });
  },
};
