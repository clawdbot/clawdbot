import { resolvePublishedModelCatalogOwner } from "./prepared-model-catalog-owner.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime.errors.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedReplyDispatchRuntime,
} from "./prepared-model-runtime.types.js";

type PreparedReplyDispatchPublication = Readonly<{
  runtimes: readonly PreparedReplyDispatchRuntime[];
}>;

const EMPTY_REPLY_DISPATCH_PUBLICATION: PreparedReplyDispatchPublication = Object.freeze({
  runtimes: Object.freeze([]),
});

function createReplyDispatchRuntime(
  runtimeOwner: PreparedModelRuntimeOwner,
): PreparedReplyDispatchRuntime {
  const snapshot = runtimeOwner.snapshot!;
  const owner = resolvePublishedModelCatalogOwner(snapshot);
  const pluginGeneration = runtimeOwner.pluginGeneration;
  const inboundPluginRegistry = pluginGeneration?.inboundPluginRegistry;
  if (!pluginGeneration || !inboundPluginRegistry) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared inbound plugin registry was not published for ${snapshot.agentDir}`,
    );
  }
  return Object.freeze({
    agentId: owner.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
    config: owner.config,
    modelCatalog: owner.modelCatalog,
    inboundPluginRegistry,
    pluginGeneration,
  });
}

function buildReplyDispatchPublication(
  owners: Iterable<PreparedModelRuntimeOwner>,
): PreparedReplyDispatchPublication {
  const runtimes = [...owners]
    .filter((owner) => owner.provenance === "configured")
    .map((owner) => {
      if (!owner.snapshot || owner.needsRefresh || owner.pending) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared reply dispatch runtime owner was not published for ${owner.input.agentId ?? owner.input.agentDir}`,
        );
      }
      return createReplyDispatchRuntime(owner);
    })
    .toSorted((left, right) => left.agentId.localeCompare(right.agentId));
  if (new Set(runtimes.map((runtime) => runtime.agentId)).size !== runtimes.length) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      "prepared reply dispatch runtime publication contains duplicate configured agents",
    );
  }
  return Object.freeze({ runtimes: Object.freeze(runtimes) });
}

function removeReplyDispatchRuntimeProjections(
  publication: PreparedReplyDispatchPublication,
  agentIds: ReadonlySet<string>,
): PreparedReplyDispatchPublication {
  if (agentIds.size === 0) {
    return publication;
  }
  return Object.freeze({
    runtimes: Object.freeze(
      publication.runtimes.filter((runtime) => !agentIds.has(runtime.agentId)),
    ),
  });
}

type PreparedReplyDispatchPublicationHost = Readonly<{
  isGatewayLifecycleActive: () => boolean;
  getPendingReplacement: () => Promise<void> | undefined;
}>;

/** Reads one immutable configured Gateway dispatch generation without activating an owner. */
export class PreparedReplyDispatchPublicationOwner {
  #publication = EMPTY_REPLY_DISPATCH_PUBLICATION;

  constructor(private readonly host: PreparedReplyDispatchPublicationHost) {}

  clear(): void {
    this.#publication = EMPTY_REPLY_DISPATCH_PUBLICATION;
  }

  rebuild(owners: Iterable<PreparedModelRuntimeOwner>): void {
    this.#publication = this.host.isGatewayLifecycleActive()
      ? buildReplyDispatchPublication(owners)
      : EMPTY_REPLY_DISPATCH_PUBLICATION;
  }

  remove(agentIds: ReadonlySet<string>): void {
    this.#publication = removeReplyDispatchRuntimeProjections(this.#publication, agentIds);
  }

  readonly load = async ({
    agentId,
  }: {
    agentId: string;
  }): Promise<PreparedReplyDispatchRuntime | undefined> => {
    for (;;) {
      if (!this.host.isGatewayLifecycleActive()) {
        return undefined;
      }
      const replacement = this.host.getPendingReplacement();
      if (replacement) {
        await replacement;
        continue;
      }
      const matches = this.#publication.runtimes.filter((runtime) => runtime.agentId === agentId);
      if (matches.length !== 1) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared reply dispatch runtime owner was not published for ${agentId}`,
        );
      }
      return matches[0];
    }
  };
}
