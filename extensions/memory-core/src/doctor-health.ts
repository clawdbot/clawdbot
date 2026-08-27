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

export const pluginStateIsolatedDoctorCheckIds = [
  MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
] as const;

type InspectManagedLocalEmbeddingSetup = (params: {
  config: Parameters<typeof collectVectorProviderFindings>[0]["config"];
  env: NodeJS.ProcessEnv;
  agentId: string;
  provider: string;
}) => ProviderFailure | null | undefined | Promise<ProviderFailure | null | undefined>;

type MemoryCoreDoctorRegistrationHost = {
  registerHealthCheck: (check: HealthCheck) => void;
  getHealthCheck: (id: string) => HealthCheck | undefined;
  inspectEmbeddingProviderSetup: InspectManagedLocalEmbeddingSetup;
  memoryCoreActive: boolean;
};

type MemoryCoreDoctorRegistrationState = Pick<
  MemoryCoreDoctorRegistrationHost,
  "inspectEmbeddingProviderSetup" | "memoryCoreActive"
>;

const registrationsByHost = new WeakMap<
  MemoryCoreDoctorRegistrationHost["registerHealthCheck"],
  {
    readonly check: HealthCheck & { readonly defaultEnabled: false };
    readonly state: MemoryCoreDoctorRegistrationState;
  }
>();

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
  state: MemoryCoreDoctorRegistrationState,
): HealthCheck & { readonly defaultEnabled: false } {
  return {
    id: MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
    kind: "plugin",
    source: "memory-core",
    defaultEnabled: false,
    description: "Checks existing semantic indexes for required managed local embedding setup.",
    async detect(ctx) {
      if (!state.memoryCoreActive) {
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
            const failure = await state.inspectEmbeddingProviderSetup({
              config: params.config,
              env: params.env,
              agentId: params.agentId,
              provider,
            });
            if (failure === undefined) {
              return {
                provider,
                reason: MISSING_LOCAL_MEMORY_EMBEDDING_PROVIDER_MESSAGE,
                requirement: "memory-embedding-provider-plugin",
                fixHint:
                  `Run \`${LLAMA_CPP_PROVIDER_INSTALL_COMMAND}\`, ensure the plugin is enabled, ` +
                  "then rerun this check.",
              };
            }
            return failure;
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
  let registration = registrationsByHost.get(host.registerHealthCheck);
  if (registration) {
    registration.state.inspectEmbeddingProviderSetup = host.inspectEmbeddingProviderSetup;
    registration.state.memoryCoreActive = host.memoryCoreActive;
  } else {
    const state: MemoryCoreDoctorRegistrationState = {
      inspectEmbeddingProviderSetup: host.inspectEmbeddingProviderSetup,
      memoryCoreActive: host.memoryCoreActive,
    };
    registration = {
      check: createManagedLocalEmbeddingSetupCheck(state),
      state,
    };
    registrationsByHost.set(host.registerHealthCheck, registration);
  }
  if (host.getHealthCheck(MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID) === registration.check) {
    return;
  }
  host.registerHealthCheck(registration.check);
}
