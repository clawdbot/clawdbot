import { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import { UpdatePreMutationError } from "./shared.js";
import { formatUpdateAncestryBlockMessage } from "./update-command-handoff.js";
import { captureOwnedManagedUpdatePreflightContext } from "./update-command-managed-context.js";
import {
  GatewayServiceUpdateOwnershipError,
  type ManagedServiceRootRedirect,
} from "./update-command-service-plan.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  type PreManagedServiceStop,
} from "./update-command-service.js";

export async function inspectUpdateDatabaseContexts(params: {
  roots: readonly string[];
  updateInstallKind: "package" | "git";
  shouldRestart: boolean;
  jsonMode: boolean;
  timeoutMs: number;
  invocationCwd?: string;
  managedServiceRootRedirect: ManagedServiceRootRedirect | null;
  expectedServices?: ReadonlyMap<string, PreManagedServiceStop>;
}) {
  let service: PreManagedServiceStop | undefined;
  const services = new Map<string, PreManagedServiceStop>();
  for (const root of new Set(params.roots)) {
    const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
      root,
      updateInstallKind: params.updateInstallKind,
      shouldRestart: params.shouldRestart,
      jsonMode: params.jsonMode,
      timeoutMs: params.timeoutMs,
      phase: "inspect",
      expectedService: params.expectedServices?.get(root),
    }).catch((error: unknown) => {
      if (error instanceof GatewayServiceUpdateOwnershipError) {
        throw new UpdatePreMutationError("managed-service-preflight", error.message);
      }
      throw error;
    });
    const unavailable =
      inspected.serviceUpdateVerdict?.kind === "unavailable"
        ? inspected.serviceUpdateVerdict.message
        : undefined;
    if (inspected.blockMessage || unavailable) {
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        formatUpdateAncestryBlockMessage(inspected.blockMessage ?? unavailable!),
      );
    }
    if (inspected.serviceUpdateVerdict?.kind === "unresolved") {
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        "Gateway service installation ownership is unresolved. Run `openclaw gateway status --deep` and retry before changing package or Git files.",
      );
    }
    services.set(root, inspected);
    if (inspected.serviceUpdateVerdict?.kind === "owned") {
      service = inspected;
      break;
    }
  }
  const managed = await captureOwnedManagedUpdatePreflightContext({
    stopState: service,
    processEnv: process.env,
    invocationCwd: params.invocationCwd,
  });
  if (params.managedServiceRootRedirect && !managed) {
    throw new UpdatePreMutationError(
      "managed-service-preflight",
      "The managed Gateway service changed before database admission. Retry so its package root and state can be inspected together.",
    );
  }
  // Redirected package replacement does not own the invoking installation's stores.
  const contexts = params.managedServiceRootRedirect
    ? []
    : [await captureTargetDatabaseSchemaContext(process.env)];
  if (managed) {
    contexts.push(managed);
  }
  return { service, services, contexts, managedEnv: managed?.env };
}
