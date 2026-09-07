/** Retains idle prepared owners and releases publication resource claims. */
import type { PreparedModelRuntimeOwner } from "./prepared-model-runtime.types.js";

export function retirePreparedModelRuntimeOwnerIfUnused(
  owners: Map<string, PreparedModelRuntimeOwner>,
  key: string,
  owner: PreparedModelRuntimeOwner,
  retained = false,
): void {
  if (
    (owner.provenance === "run" || owner.provenance === "ephemeral") &&
    (owner.admissionCount ?? 0) === 0 &&
    (owner.leaseCount ?? 0) === 0 &&
    !retained
  ) {
    if (owners.get(key) === owner) {
      owners.delete(key);
    }
    releasePreparedModelRuntimeOwnerResources(owner);
  }
}

/** Unpublication releases its own claim; admitted turns retain their immutable generations. */
export function releasePreparedModelRuntimeOwnerResources(owner: PreparedModelRuntimeOwner): void {
  const resources = owner.resources;
  owner.resources = undefined;
  resources?.release();
}

export class PreparedModelRuntimeOwnerRetention {
  readonly #retained = new Map<string, PreparedModelRuntimeOwner>();
  constructor(private readonly maxSize: number) {}

  clear(owners: Map<string, PreparedModelRuntimeOwner>): void {
    // Released run owners retire here; active leases retire on release.
    for (const [key, owner] of this.#retained) {
      retirePreparedModelRuntimeOwnerIfUnused(owners, key, owner);
    }
    this.#retained.clear();
  }

  has(key: string, owner: PreparedModelRuntimeOwner): boolean {
    return this.#retained.get(key) === owner;
  }

  retain(
    key: string,
    owner: PreparedModelRuntimeOwner,
    owners: Map<string, PreparedModelRuntimeOwner>,
  ): void {
    if (owner.provenance !== "run") {
      return;
    }
    const previous = this.#retained.get(key);
    this.#retained.delete(key);
    this.#retained.set(key, owner);
    if (previous && previous !== owner) {
      retirePreparedModelRuntimeOwnerIfUnused(owners, key, previous);
    }
    while (this.#retained.size > this.maxSize) {
      const oldest = this.#retained.entries().next().value;
      if (!oldest) {
        return;
      }
      const [oldestKey, oldestOwner] = oldest;
      this.#retained.delete(oldestKey);
      retirePreparedModelRuntimeOwnerIfUnused(owners, oldestKey, oldestOwner);
    }
  }
}
