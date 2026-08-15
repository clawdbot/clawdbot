import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
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
  inspectManagedLocalEmbeddingSetup: InspectManagedLocalEmbeddingSetup;
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
  const provider = configured?.trim();
  return !provider || provider === "auto" ? "openai" : provider;
}

function createManagedLocalEmbeddingSetupCheck(
  inspectManagedLocalEmbeddingSetup: InspectManagedLocalEmbeddingSetup,
): HealthCheck {
  return {
    id: MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
    kind: "plugin",
    source: "memory-core",
    description: "Checks existing semantic indexes for required managed local embedding setup.",
    async detect(ctx) {
      const env = ctx.env ?? process.env;
      const findings = await collectVectorProviderFindings(
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
          return await inspectManagedLocalEmbeddingSetup({
            config: params.config,
            env: params.env,
            agentId: params.agentId,
            provider,
          });
        },
      );
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
    createManagedLocalEmbeddingSetupCheck(host.inspectManagedLocalEmbeddingSetup),
  );
  registeredHosts.add(host.registerHealthCheck);
}
