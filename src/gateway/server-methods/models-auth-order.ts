import {
  ErrorCodes,
  errorShape,
  validateModelsAuthOrderSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  resolveExplicitAuthOrderSelection,
  setAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import {
  clearCurrentProviderAuthState,
  warmCurrentProviderAuthStateOffMainThread,
} from "../../agents/model-provider-auth.js";
import { refreshPreparedModelRuntimeSnapshots } from "../../agents/prepared-model-runtime.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { refreshActiveProviderAuthRuntimeSnapshot } from "../../secrets/runtime.js";
import { readPreparedCatalog } from "../server-model-catalog-auth.js";
import { formatForLog } from "../ws-log.js";
import { modelAuthAgentScopeError, resolveModelAuthAgentScope } from "./model-auth-agent-scope.js";
import { resolveConfigBoundProfileIds } from "./models-auth-status-config.js";
import { clearModelAuthStatusUsageCache } from "./models-auth-status-usage-cache.js";
import type { ModelAuthOrderSetResult } from "./models-auth-status.types.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const log = createSubsystemLogger("models-auth-order");

export const modelsAuthOrderHandlers: GatewayRequestHandlers = {
  "models.authOrderSet": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateModelsAuthOrderSetParams, "models.authOrderSet", respond)
    ) {
      return;
    }
    const provider = params.provider;
    const profileIds = params.profileIds ?? null;
    const rejectInvalidOrder = (message: string) =>
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
    try {
      const cfg = context.getRuntimeConfig();
      const scope = resolveModelAuthAgentScope(cfg, params.agentId);
      if (!scope.ok) {
        respond(false, undefined, modelAuthAgentScopeError(scope));
        return;
      }
      const preparedSnapshot = await readPreparedCatalog(context, scope.agentId);
      if (!preparedSnapshot) {
        throw new Error(`prepared model auth owner is unavailable (${scope.agentId})`);
      }
      const authAliasLookupParams = {
        config: preparedSnapshot.config,
        workspaceDir: preparedSnapshot.workspaceDir,
        metadataSnapshot: preparedSnapshot.metadataSnapshot,
        includeUntrustedWorkspacePlugins: false,
      };
      const authProvider = resolveProviderIdForAuth(provider, authAliasLookupParams);
      const configuredOrder = resolveExplicitAuthOrderSelection({
        storeOrder: preparedSnapshot.authStore.order,
        configuredOrder: preparedSnapshot.config.auth?.order,
        providerKey: provider,
        providerAuthKey: authProvider,
      });
      if (profileIds && configuredOrder.order !== undefined && !configuredOrder.fromStore) {
        rejectInvalidOrder(
          `profile priority for provider ${provider} is controlled by auth configuration`,
        );
        return;
      }
      const availableProfileIds = Object.entries(preparedSnapshot.authStore.profiles)
        .filter(
          ([, credential]) =>
            resolveProviderIdForAuth(credential.provider, authAliasLookupParams) === authProvider,
        )
        .map(([profileId]) => profileId);
      const configBoundProfileIds = resolveConfigBoundProfileIds(
        preparedSnapshot.config,
        preparedSnapshot.authStore,
        authAliasLookupParams,
      );
      if (
        profileIds &&
        availableProfileIds.some((profileId) => configBoundProfileIds.has(profileId))
      ) {
        rejectInvalidOrder(
          `profile priority for provider ${provider} is controlled by provider configuration`,
        );
        return;
      }
      const invalidProfile = profileIds?.find((profileId) => {
        const credential = preparedSnapshot.authStore.profiles[profileId];
        return (
          !credential ||
          resolveProviderIdForAuth(credential.provider, authAliasLookupParams) !== authProvider
        );
      });
      if (invalidProfile) {
        rejectInvalidOrder(`profileId ${invalidProfile} is unavailable for provider ${provider}`);
        return;
      }
      if (profileIds && profileIds.length !== availableProfileIds.length) {
        rejectInvalidOrder(
          `profileIds must include every available profile for provider ${provider}`,
        );
        return;
      }
      const updated = await setAuthProfileOrder({
        agentDir: preparedSnapshot.agentDir,
        provider: authProvider,
        order: profileIds,
        sharedStoreWrite: true,
      });
      if (!updated) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "auth profile order is temporarily unavailable"),
        );
        return;
      }
      clearModelAuthStatusUsageCache();
      clearCurrentProviderAuthState();
      const result: ModelAuthOrderSetResult = { provider, profileIds };
      respond(true, result, undefined);
      void Promise.all([
        refreshActiveProviderAuthRuntimeSnapshot(),
        refreshPreparedModelRuntimeSnapshots(cfg, {
          catalogMode: "static",
          allowGatewaySubagentBinding: true,
          agentIds: new Set([scope.agentId]),
          pluginMetadataSnapshot: preparedSnapshot.metadataSnapshot,
        }),
        warmCurrentProviderAuthStateOffMainThread(cfg),
      ]).catch((err: unknown) => {
        log.warn(`provider auth state refresh after reorder failed: ${formatForLog(err)}`);
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
