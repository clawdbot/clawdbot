import type { SecretRef } from "../../config/types.secrets.js";
import type {
  WorkerProfile,
  WorkerProvider,
  WorkerSshIdentity,
  WorkerSshIdentityRequestV2,
} from "../../plugins/types.js";

type GenericWorkerSshIdentityResolver = (
  keyRef: SecretRef,
  assertAuthorized: () => void,
) => Promise<WorkerSshIdentity>;

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
  assertAuthorized: () => void;
  resolveGeneric: GenericWorkerSshIdentityResolver;
}): Promise<WorkerSshIdentity> {
  params.assertAuthorized();
  const request: WorkerSshIdentityRequestV2 = {
    leaseId: params.leaseId,
    profile: params.profile,
    keyRef: params.keyRef,
    assertAuthorized: params.assertAuthorized,
  };
  const identity = params.provider.resolveSshIdentity
    ? await params.provider.resolveSshIdentity(request)
    : await params.resolveGeneric(params.keyRef, params.assertAuthorized);
  params.assertAuthorized();
  return requireIdentity(identity);
}
