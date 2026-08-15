import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  LLAMA_CPP_PROVIDER_INSTALL_COMMAND,
  LOCAL_MEMORY_EMBEDDING_PROVIDER_ID,
  MISSING_LOCAL_MEMORY_EMBEDDING_PROVIDER_MESSAGE,
} from "./memory/local-embedding-provider.js";
import {
  collectVectorProviderFindings,
  type ProviderFailure,
} from "./migration/doctor-vector-index-provider-diagnostic.js";

export const MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID =
  "memory-core/managed-local-embedding-setup";

type InspectManagedLocalEmbeddingSetup = (params: {
  config: Parameters<typeof collectVectorProviderFindings>[0]["config"];
  env: NodeJS.ProcessEnv;
  agentId: string;
  provider: string;
}) => ProviderFailure | null | Promise<ProviderFailure | null>;

type MemoryCoreDoctorRegistrationHost = {
  registerHealthCheck: (check: HealthCheck) => void;
  resolveEmbeddingProviderSetupInspector: (
    provider: string,
  ) => InspectManagedLocalEmbeddingSetup | undefined;
  memoryCoreActive: boolean;
};

const registeredHosts = new WeakSet<MemoryCoreDoctorRegistrationHost["registerHealthCheck"]>();

function resolveSelectedMemoryProvider(
  config: Parameters<typeof collectVectorProviderFindings>[0]["config"],
  agentId: string,
): string | null {
  const agent =
    config.agents?.entries?.[agentId] ?? config.agents?.list?.find((entry) => entry.id === agentId);
  const defaults = config.memory?.search;
  const overrides = agent?.memory?.search;
  if (!(overrides?.enabled ?? defaults?.enabled ?? true)) {
    return null;
  }
  const configured = overrides?.provider ?? defaults?.provider;
  const provider = normalizeOptionalLowercaseString(configured);
  return !provider || provider === "auto" ? "openai" : provider;
}

function createManagedLocalEmbeddingSetupCheck(
  resolveEmbeddingProviderSetupInspector: MemoryCoreDoctorRegistrationHost["resolveEmbeddingProviderSetupInspector"],
  memoryCoreActive: boolean,
): HealthCheck {
  return {
    id: MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
    kind: "plugin",
    source: "memory-core",
    description: "Checks existing semantic indexes for required managed local embedding setup.",
    async detect(ctx) {
      if (!memoryCoreActive) {
        return [];
      }
      const env = ctx.env ?? process.env;
      let findings: Awaited<ReturnType<typeof collectVectorProviderFindings>>;
      try {
        findings = await collectVectorProviderFindings(
          {
            config: ctx.cfg,
            env,
            stateDir: resolveStateDir(env),
          },
          async (params) => {
            const provider = resolveSelectedMemoryProvider(params.config, params.agentId);
            if (!provider || provider === "none") {
              return null;
            }
            if (provider !== LOCAL_MEMORY_EMBEDDING_PROVIDER_ID) {
              return null;
            }
            const inspectManagedLocalEmbeddingSetup =
              resolveEmbeddingProviderSetupInspector(provider);
            if (!inspectManagedLocalEmbeddingSetup) {
              return {
                provider,
                reason: MISSING_LOCAL_MEMORY_EMBEDDING_PROVIDER_MESSAGE,
                requirement: "memory-embedding-provider-plugin",
                fixHint:
                  `Run \`${LLAMA_CPP_PROVIDER_INSTALL_COMMAND}\`, ensure the plugin is enabled, ` +
                  "then rerun this check.",
              };
            }
            return await inspectManagedLocalEmbeddingSetup({
              config: params.config,
              env: params.env,
              agentId: params.agentId,
              provider,
            });
          },
          {
            indexInspectionMode: "readiness",
            inspectConfiguredMemorySecretRefs: true,
          },
        );
      } catch (error) {
        return [
          {
            checkId: MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
            severity: "error",
            source: "memory-core",
            target: "memory-core",
            requirement: "memory-index-inspection",
            message:
              "Memory Core semantic-index readiness could not be verified " +
              `(${formatErrorMessage(error)}).`,
            fixHint:
              "Keep the current Gateway running, resolve the database inspection error, then rerun this check.",
          },
        ];
      }
      return findings.map((finding) => ({
        checkId: MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
        severity: "error" as const,
        source: "memory-core",
        path: `${finding.configPrefix}.provider`,
        target: `${finding.agentId}/${finding.provider}`,
        requirement: finding.requirement ?? "managed-local-embedding-setup",
        message:
          `Memory index for agent ${finding.agentId} uses vector model ${finding.model}, but ` +
          `embedding provider "${finding.provider}" cannot initialize (${finding.reason}).`,
        fixHint: finding.fixHint,
      }));
    },
  };
}

export function registerMemoryCoreDoctorChecks(host: MemoryCoreDoctorRegistrationHost): void {
  if (registeredHosts.has(host.registerHealthCheck)) {
    return;
  }
  host.registerHealthCheck(
    createManagedLocalEmbeddingSetupCheck(
      host.resolveEmbeddingProviderSetupInspector,
      host.memoryCoreActive,
    ),
  );
  registeredHosts.add(host.registerHealthCheck);
}
