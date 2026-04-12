import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createExecApprovalForwarder } from "../infra/exec-approval-forwarder.js";
import { type PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import {
  resolveCommandSecretsFromActiveRuntimeSnapshot,
  type CommandSecretAssignment,
} from "../secrets/runtime-command-secrets.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { createExecApprovalIosPushDelivery } from "./exec-approval-ios-push.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { createExecApprovalHandlers } from "./server-methods/exec-approval.js";
import { createPluginApprovalHandlers } from "./server-methods/plugin-approval.js";
import { createSecretsHandlers } from "./server-methods/secrets.js";
import {
  disconnectStaleSharedGatewayAuthClients,
  setCurrentSharedGatewaySessionGeneration,
  type SharedGatewayAuthClient,
  type SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";
import type { ActivateRuntimeSecrets } from "./server-startup-config.js";

type GatewayAuxHandlerLogger = {
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};

export function createGatewayAuxHandlers(params: {
  log: GatewayAuxHandlerLogger;
  activateRuntimeSecrets: ActivateRuntimeSecrets;
  sharedGatewaySessionGenerationState: SharedGatewaySessionGenerationState;
  resolveSharedGatewaySessionGenerationForConfig: (config: OpenClawConfig) => string | undefined;
  clients: Iterable<SharedGatewayAuthClient>;
}) {
  const execApprovalManager = new ExecApprovalManager();
  const execApprovalForwarder = createExecApprovalForwarder();
  const execApprovalIosPushDelivery = createExecApprovalIosPushDelivery({ log: params.log });
  const execApprovalHandlers = createExecApprovalHandlers(execApprovalManager, {
    forwarder: execApprovalForwarder,
    iosPushDelivery: execApprovalIosPushDelivery,
  });
  const pluginApprovalManager = new ExecApprovalManager<PluginApprovalRequestPayload>();
  const pluginApprovalHandlers = createPluginApprovalHandlers(pluginApprovalManager, {
    forwarder: execApprovalForwarder,
  });
  const secretsHandlers = createSecretsHandlers({
    reloadSecrets: async () => {
      const active = getActiveSecretsRuntimeSnapshot();
      if (!active) {
        throw new Error("Secrets runtime snapshot is not active.");
      }
      const previousSharedGatewaySessionGeneration =
        params.sharedGatewaySessionGenerationState.current;
      const prepared = await params.activateRuntimeSecrets(active.sourceConfig, {
        reason: "reload",
        activate: true,
      });
      const nextSharedGatewaySessionGeneration =
        params.resolveSharedGatewaySessionGenerationForConfig(prepared.config);
      setCurrentSharedGatewaySessionGeneration(
        params.sharedGatewaySessionGenerationState,
        nextSharedGatewaySessionGeneration,
      );
      if (previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration) {
        disconnectStaleSharedGatewayAuthClients({
          clients: params.clients,
          expectedGeneration: nextSharedGatewaySessionGeneration,
        });
      }
      return { warningCount: prepared.warnings.length };
    },
    resolveSecrets: async ({ commandName, targetIds }) => {
      const { assignments, diagnostics, inactiveRefPaths } =
        resolveCommandSecretsFromActiveRuntimeSnapshot({
          commandName,
          targetIds: new Set(targetIds),
        });
      if (assignments.length === 0) {
        return { assignments: [] as CommandSecretAssignment[], diagnostics, inactiveRefPaths };
      }
      return { assignments, diagnostics, inactiveRefPaths };
    },
  });

  return {
    execApprovalManager,
    pluginApprovalManager,
    extraHandlers: {
      ...execApprovalHandlers,
      ...pluginApprovalHandlers,
      ...secretsHandlers,
    },
  };
}
