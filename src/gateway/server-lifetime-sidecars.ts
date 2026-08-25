import { getRuntimeConfig } from "../config/config.js";
import { purgeExpiredSecretStoreEntries } from "../secrets/store/secret-store.js";
import {
  createGitHubOAuthLifecycle,
  installActiveGitHubOAuthLifecycle,
} from "./github-oauth-lifecycle.js";
import type { createGatewayChatMetadataLifecycle } from "./server-chat-metadata-lifecycle.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

type GatewayChatMetadataLifecycle = Awaited<ReturnType<typeof createGatewayChatMetadataLifecycle>>;
const SECRET_STORE_EXPIRY_INTERVAL_MS = 60_000;
const GITHUB_PUBLICATION_RECONCILE_INTERVAL_MS = 60_000;

function startGitHubPublicationMaintenance(
  reconcile: () => Promise<void>,
  logWarning: (message: string) => void,
): GatewayPostReadySidecarHandle {
  let current: Promise<void> | undefined;
  let stopped = false;
  const run = () => {
    if (stopped || current) {
      return;
    }
    const operation = reconcile()
      .catch(() => logWarning("GitHub publication recovery failed; will retry."))
      .finally(() => {
        if (current === operation) {
          current = undefined;
        }
      });
    current = operation;
  };
  run();
  const interval = setInterval(run, GITHUB_PUBLICATION_RECONCILE_INTERVAL_MS);
  interval.unref?.();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      await current;
    },
  };
}

function startSecretStoreExpiryMaintenance(
  logWarning: (message: string) => void,
): GatewayPostReadySidecarHandle {
  let warned = false;
  const purge = () => {
    try {
      purgeExpiredSecretStoreEntries();
      warned = false;
    } catch {
      if (!warned) {
        logWarning("Secret store expiry cleanup failed; will retry.");
        warned = true;
      }
    }
  };
  purge();
  const interval = setInterval(purge, SECRET_STORE_EXPIRY_INTERVAL_MS);
  interval.unref?.();
  return { stop: () => clearInterval(interval) };
}

export async function attachInitialGatewayLifetimeSidecars(params: {
  chatMetadataLifecycle: GatewayChatMetadataLifecycle;
  gatewayRequestContext: GatewayRequestContext;
  flushPendingSessionsChangedEvents: (context?: object) => void;
  minimalTestGateway: boolean;
  logWarning: (message: string) => void;
  reconcileGitHubPublications?: () => Promise<void>;
  sidecars: GatewayPostReadySidecarHandle[];
}): Promise<void> {
  await params.chatMetadataLifecycle.attachContext(params.gatewayRequestContext, params.sidecars);
  const githubOAuth = createGitHubOAuthLifecycle({
    getConfig: params.gatewayRequestContext.getRuntimeConfig,
    getPersistedConfig: () => getRuntimeConfig({ pin: false }),
    warn: params.logWarning,
  });
  params.gatewayRequestContext.githubOAuthService = githubOAuth;
  const uninstallGitHubOAuth = installActiveGitHubOAuthLifecycle(githubOAuth);
  if (!params.minimalTestGateway) {
    githubOAuth.start();
  }
  params.sidecars.push({
    stop: async () => {
      uninstallGitHubOAuth();
      await githubOAuth.stop();
      if (params.gatewayRequestContext.githubOAuthService === githubOAuth) {
        delete params.gatewayRequestContext.githubOAuthService;
      }
    },
  });
  if (!params.minimalTestGateway) {
    params.sidecars.push(startSecretStoreExpiryMaintenance(params.logWarning));
  }
  if (params.reconcileGitHubPublications) {
    params.sidecars.push(
      startGitHubPublicationMaintenance(params.reconcileGitHubPublications, params.logWarning),
    );
  }
  params.sidecars.push({
    stop: () => {
      params.flushPendingSessionsChangedEvents(params.gatewayRequestContext);
    },
  });
}
