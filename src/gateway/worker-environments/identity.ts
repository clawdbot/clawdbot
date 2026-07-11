import type { SecretRef } from "../../config/types.secrets.js";
import type { WorkerProfile, WorkerProvider, WorkerSshIdentity } from "../../plugins/types.js";

export type GenericWorkerSshIdentityResolver = (keyRef: SecretRef) => Promise<WorkerSshIdentity>;

function requireIdentity(value: unknown): WorkerSshIdentity {
  if (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "path" &&
    "path" in value &&
    typeof value.path === "string" &&
    value.path.trim()
  ) {
    return { kind: "path", path: value.path };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "material" &&
    "contents" in value &&
    typeof value.contents === "string" &&
    value.contents.trim()
  ) {
    return { kind: "material", contents: value.contents };
  }
  throw new Error("Worker SSH identity resolver returned an invalid identity");
}

/** Routes dynamic identities to their provider owner and configured refs to the generic resolver. */
export async function resolveWorkerSshIdentity(params: {
  provider: WorkerProvider;
  leaseId: string;
  profile: WorkerProfile;
  keyRef: SecretRef;
  resolveGeneric: GenericWorkerSshIdentityResolver;
}): Promise<WorkerSshIdentity> {
  const identity = params.provider.resolveSshIdentity
    ? await params.provider.resolveSshIdentity({
        leaseId: params.leaseId,
        profile: params.profile,
        keyRef: params.keyRef,
      })
    : await params.resolveGeneric(params.keyRef);
  return requireIdentity(identity);
}
