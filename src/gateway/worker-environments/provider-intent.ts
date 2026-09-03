import fsp from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import type { WorkerExecutionMode, WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import { requireInheritedWorkerProfileAuthorization } from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { prepareWorkerProjectSnapshot } from "./workspace-git-base.js";

type WorkerProviderIntentOptions = Pick<
  WorkerProviderLifecycleOptions,
  | "store"
  | "getConfig"
  | "projectNamespace"
  | "isStopping"
  | "inState"
  | "withLock"
  | "serviceError"
> & {
  providerFor: (providerId: string) => WorkerProvider;
  requireWorkerProfile: (value: unknown) => WorkerProfile;
  resumeProvision: (
    record: WorkerEnvironmentRecord,
    provider?: WorkerProvider,
    signal?: AbortSignal,
  ) => Promise<WorkerEnvironmentRecord>;
};

/** Admits one immutable allocation intent before the provider lifecycle can allocate a lease. */
export function createWorkerProviderIntent(options: WorkerProviderIntentOptions) {
  const {
    store,
    inState,
    serviceError,
    withLock,
    providerFor,
    requireWorkerProfile,
    resumeProvision,
  } = options;
  return async (
    profileId: string,
    idempotencyKey: string,
    createOptions: {
      inherited?: {
        providerId: string;
        profileSnapshot: WorkerProfile;
      };
      machineClass?: string;
      executionMode?: WorkerExecutionMode;
      projectPath?: string;
      signal?: AbortSignal;
    } = {},
  ) => {
    const {
      inherited: requestedInherited,
      machineClass,
      executionMode,
      projectPath,
      signal,
    } = createOptions;
    signal?.throwIfAborted();
    const inherited = requestedInherited
      ? { ...requestedInherited, profileSnapshot: { ...requestedInherited.profileSnapshot } }
      : undefined;
    // Project authority belongs to this allocation. Ignore the source allocation's
    // descriptor during both fresh admission and comparison with an existing intent.
    if (inherited) {
      delete inherited.profileSnapshot.project;
    }
    const provisionSnapshot = {
      ...(machineClass === undefined ? {} : { machineClass }),
      ...(executionMode === undefined ? {} : { executionMode }),
    };
    if (options.isStopping()) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    const normalizedProfileId = profileId.trim();
    if (!normalizedProfileId || normalizedProfileId !== profileId) {
      throw serviceError("invalid_profile", "Worker profile id must be non-empty and trimmed");
    }
    const { environmentId, provisionOperationId } = deriveEnvironmentIntent(idempotencyKey);
    return withLock(environmentId, async () => {
      signal?.throwIfAborted();
      if (options.isStopping()) {
        throw serviceError("invalid_state", "Worker environment service is stopping");
      }
      const existing = store.get(environmentId);
      if (existing) {
        const existingProject = readWorkerProjectSnapshot(existing.profileSnapshot.project);
        if (existingProject && projectPath) {
          const root = await fsp.realpath(projectPath);
          signal?.throwIfAborted();
          if (existingProject.root !== root) {
            throw serviceError("invalid_profile", "Idempotency key belongs to another project");
          }
        }
        if (
          existing.profileId !== normalizedProfileId ||
          (inherited !== undefined &&
            (existing.providerId !== inherited.providerId ||
              !isDeepStrictEqual(existing.profileSnapshot, {
                ...inherited.profileSnapshot,
                ...provisionSnapshot,
                ...(existingProject ? { project: existingProject } : {}),
              }))) ||
          (inherited === undefined &&
            (existing.profileSnapshot.machineClass !== machineClass ||
              existing.profileSnapshot.executionMode !== executionMode))
        ) {
          throw serviceError("invalid_profile", "Idempotency key belongs to another profile");
        }
        if (existing.destroyRequestedAtMs !== null) {
          return existing;
        }
        if (!existing.leaseId && inState(existing, "requested", "provisioning")) {
          return resumeProvision(existing, undefined, signal);
        }
        return existing;
      }
      let provider: WorkerProvider;
      let providerId: string;
      let profileSnapshot: WorkerProfile;
      const profiles = options.getConfig().cloudWorkers?.profiles;
      const configuredProfile =
        profiles && Object.hasOwn(profiles, normalizedProfileId)
          ? profiles[normalizedProfileId]
          : undefined;
      if (inherited) {
        providerId = normalizeCapabilityProviderId(inherited.providerId) ?? inherited.providerId;
        if (providerId !== inherited.providerId) {
          throw serviceError("invalid_profile", "Inherited worker provider id is not canonical");
        }
        requireInheritedWorkerProfileAuthorization(
          normalizedProfileId,
          providerId,
          inherited.profileSnapshot.settings,
          configuredProfile?.provider,
          serviceError,
        );
        provider = providerFor(providerId);
        const resolvedProviderId = normalizeCapabilityProviderId(provider.id) ?? provider.id;
        if (resolvedProviderId !== providerId) {
          throw serviceError("invalid_profile", "Inherited worker provider identity changed");
        }
        profileSnapshot = requireWorkerProfile({
          ...inherited.profileSnapshot,
          ...provisionSnapshot,
        });
      } else {
        if (!configuredProfile) {
          throw serviceError("profile_not_found", `Unknown worker profile: ${normalizedProfileId}`);
        }
        provider = providerFor(configuredProfile.provider);
        providerId = normalizeCapabilityProviderId(provider.id) ?? provider.id;
        const settings = requireWorkerProfile(configuredProfile.settings ?? {});
        profileSnapshot = requireWorkerProfile({
          install: configuredProfile.install ?? "bundle",
          settings,
          ...provisionSnapshot,
        });
      }
      if (
        projectPath &&
        provider.supportsProjectPreparation?.(
          requireWorkerProfile(profileSnapshot.settings),
          machineClass,
        )
      ) {
        if (!options.projectNamespace) {
          throw serviceError(
            "invalid_state",
            "Worker project preparation namespace is unavailable",
          );
        }
        const project = await prepareWorkerProjectSnapshot({
          localPath: projectPath,
          namespace: options.projectNamespace,
          signal,
        });
        signal?.throwIfAborted();
        if (options.isStopping()) {
          throw serviceError("invalid_state", "Worker environment service is stopping");
        }
        if (project) {
          profileSnapshot = { ...profileSnapshot, project };
        }
      }
      const intent = store.createIntent({
        environmentId,
        providerId,
        profileId: normalizedProfileId,
        profileSnapshot,
        provisionOperationId,
      });
      return resumeProvision(intent, provider, signal);
    });
  };
}
