/** Owns registration resources independently of runtime activation authority. */
import { AsyncLocalStorage } from "node:async_hooks";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginRuntimeLifecycleRegistration } from "./host-hooks.js";
import {
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
  isPluginRegistryActivated,
  isPluginRegistryRetired,
  markPluginRegistryRetired,
} from "./registry-lifecycle.js";
import {
  pluginRegistryResourceState,
  retainPluginRegistryResources,
  type PluginRegistryResourceClaim,
  type RegistrationResourceOwner,
} from "./registry-resource-claims.js";
import { bindPluginRegistryRuntime, getPluginRegistryRuntime } from "./registry-runtime-binding.js";
import type { PluginRegistry } from "./registry-types.js";

// Disposal owns the reset callback even when lifecycle lookup initializes claim state first.
const resources = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginRegistryResources"),
  () => pluginRegistryResourceState,
  () => drainPluginRegistryResourceDisposals(),
  "plugin-registry",
);

export { retainPluginRegistryResources } from "./registry-resource-claims.js";
export type { PluginRegistryResourceClaim } from "./registry-resource-claims.js";
export type PluginRegistryHandle = PluginRegistryResourceClaim & { registry: PluginRegistry };

/** Creates construction ownership before any plugin registration callback executes. */
export function createPluginRegistryResourceOwner(
  registry: PluginRegistry,
  kind: RegistrationResourceOwner["kind"],
): PluginRegistryResourceClaim {
  if (resources.owners.has(registry)) {
    throw new Error("Plugin registry resource owner already exists");
  }
  const owner: RegistrationResourceOwner = {
    registry,
    kind,
    references: 0,
    disposing: false,
    onUnreferenced() {
      if (owner.kind === "scoped" && !isPluginRegistryActivated(owner.registry)) {
        disposeRegistrationResources(owner);
      }
    },
    disposers: new Map(),
    failures: [],
    registrations: new Set(),
  };
  resources.owners.set(registry, [owner]);
  return retainPluginRegistryResources(registry);
}

/** Keeps a disposer even if registration rollback removes the public contribution. */
export function registerPluginRegistryResourceDisposer(
  registry: PluginRegistry,
  pluginId: string,
  lifecycle: PluginRuntimeLifecycleRegistration,
): void {
  const owner = resources.owners.get(registry)?.find((entry) => entry.registry === registry);
  if (owner && lifecycle.dispose) {
    owner.disposers.set(lifecycle, pluginId);
  }
}

/** Associates copy-on-write aliases with exact, flattened source registrations and borrows. */
export function associatePluginRegistryResourceAlias(
  alias: PluginRegistry,
  source: PluginRegistry,
  ...borrowed: PluginRegistry[]
): PluginRegistry {
  const owners = [
    ...new Set([source, ...borrowed].flatMap((entry) => resources.owners.get(entry) ?? [])),
  ];
  if (owners.some((owner) => owner.disposing) || isPluginRegistryRetired(source)) {
    throw new Error("Cannot adopt disposed plugin registry resources");
  }
  const canonical = resources.aliases.get(source)?.source ?? source;
  const signal = capturePluginRegistryLifecycleSignal(
    canonical,
    capturePluginRegistryLifecycleEpoch(canonical),
    { scopedRuntime: true },
  );
  if (!signal) {
    throw new Error("Cannot adopt retired plugin registry resources");
  }
  resources.owners.set(alias, owners);
  resources.aliases.set(alias, { source: canonical, signal });
  const runtime = getPluginRegistryRuntime(source);
  if (runtime && !getPluginRegistryRuntime(alias)) {
    bindPluginRegistryRuntime(alias, runtime);
  }
  return alias;
}

/** Tracks invalid async registration until its real work ends before closing its resources. */
export function trackPluginRegistryRegistrationWork(
  registry: PluginRegistry,
  pending: Promise<unknown>,
): void {
  const owner = resources.owners.get(registry)?.find((entry) => entry.registry === registry);
  const completion = pending.then(
    () => undefined,
    () => undefined,
  );
  if (!owner) {
    return;
  }
  owner.registrations.add(completion);
  resources.pending.add(completion);
  void completion.then(() => {
    owner.registrations.delete(completion);
    resources.pending.delete(completion);
  });
}

/** Registration rollback owns only the failed plugin's new resource-only callbacks. */
export function disposePluginRegistrationResources(
  registry: PluginRegistry,
  pluginId: string,
): void {
  const owner = resources.owners.get(registry)?.find((entry) => entry.registry === registry);
  if (!owner) {
    return;
  }
  scheduleRegistrationResourceDisposal(
    owner,
    [...owner.disposers].filter(([, id]) => id === pluginId),
  );
}

/** Explicit failed-root construction cleanup is separate from scoped last-user retirement. */
export function abandonPluginRegistryResourceConstruction(registry: PluginRegistry): void {
  const owner = resources.owners.get(registry)?.find((entry) => entry.registry === registry);
  if (owner) {
    disposeRegistrationResources(owner);
  }
}

function disposeRegistrationResources(owner: RegistrationResourceOwner): void {
  if (owner.disposing) {
    return;
  }
  owner.disposing = true;
  // Reentrant cache/abort callbacks observe final disposal before plugin code runs.
  markPluginRegistryRetired(owner.registry);
  scheduleRegistrationResourceDisposal(owner, [...owner.disposers]);
}

function scheduleRegistrationResourceDisposal(
  owner: RegistrationResourceOwner,
  disposers: [PluginRuntimeLifecycleRegistration, string][],
): void {
  for (const [lifecycle] of disposers) {
    owner.disposers.delete(lifecycle);
  }
  const completion = (owner.completion ?? Promise.resolve()).then(async () => {
    while (owner.registrations.size > 0) {
      await Promise.all(owner.registrations);
    }
    for (const [lifecycle, pluginId] of disposers) {
      try {
        await lifecycle.dispose?.();
      } catch (cause) {
        const message = `Plugin resource disposal failed: ${pluginId}:${lifecycle.id}`;
        owner.registry.diagnostics.push({ level: "warn", pluginId, message });
        const failure = new Error(message, { cause });
        owner.failures.push(failure);
        if (resources.failures.length < 128) {
          resources.failures.push(failure);
        } else {
          resources.overflowFailures += 1;
        }
      }
    }
  });
  owner.completion = completion;
  resources.pending.add(completion);
  void completion.then(() => resources.pending.delete(completion));
}

/** Joins actual cleanup completion; a caller timeout must never stand in for settled work. */
export async function drainPluginRegistryResourceDisposals(): Promise<void> {
  while (resources.pending.size > 0) {
    await Promise.all(resources.pending);
  }
  const failures = resources.failures.splice(0);
  if (resources.overflowFailures > 0) {
    failures.push(
      new Error(`${resources.overflowFailures} additional plugin resource disposals failed`),
    );
    resources.overflowFailures = 0;
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Plugin registration resources could not all be disposed");
  }
}

/** One explicit build or host-operation lifetime, including all nested registry acquisitions. */
export class PluginRegistryResourceScope {
  readonly #claims = new Map<PluginRegistry, PluginRegistryResourceClaim>();
  readonly #registries = new Set<PluginRegistry>();
  readonly #pending = new Set<Promise<void>>();
  readonly #releaseCompletion = createDeferredCore();
  #releaseRequested = false;
  #released = false;

  get releaseCompletion(): Promise<void> {
    return this.#releaseCompletion.promise;
  }

  assertOpen(): void {
    if (this.#releaseRequested) {
      throw new Error("Plugin registry resource scope has been released");
    }
  }

  assertRetained(): void {
    if (this.#released || (this.#releaseRequested && registryResourceScope.getStore() !== this)) {
      throw new Error("Plugin registry resource scope has been released");
    }
  }

  run<T>(operation: () => T): T {
    this.assertOpen();
    return withPluginRegistryResourceScope(this, operation);
  }

  retain(registry: PluginRegistry): void {
    this.assertRetained();
    if (!this.#claims.has(registry)) {
      this.#claims.set(registry, retainPluginRegistryResources(registry));
      this.#registries.add(registry);
    }
  }

  adopt(handle: PluginRegistryHandle): PluginRegistry {
    try {
      this.assertRetained();
    } catch (error) {
      handle.release();
      throw error;
    }
    if (this.#claims.has(handle.registry)) {
      handle.release();
    } else {
      this.#claims.set(handle.registry, handle);
      this.#registries.add(handle.registry);
    }
    return handle.registry;
  }

  registrySources(): Iterable<PluginRegistry> {
    return this.#registries.values();
  }

  retainFrom(scope: PluginRegistryResourceScope): void {
    for (const registry of scope.registrySources()) {
      this.retain(registry);
    }
  }

  /** Reacquires the same source facts; disposed sources reject rather than revive. */
  fork(): PluginRegistryResourceScope {
    const fork = new PluginRegistryResourceScope();
    try {
      for (const registry of this.#registries) {
        fork.retain(registry);
      }
      return fork;
    } catch (error) {
      fork.release();
      throw error;
    }
  }

  /** Keeps actual work and its inherited scope alive beyond a caller's cancellation race. */
  hold(pending: Promise<unknown>): void {
    this.assertRetained();
    const settle = () => {
      this.#pending.delete(completion);
      if (this.#releaseRequested && this.#pending.size === 0) {
        this.#finishRelease();
      }
      resources.pending.delete(completion);
    };
    const completion = Promise.resolve(pending).then(settle, settle);
    this.#pending.add(completion);
    resources.pending.add(completion);
  }

  /** Joins disposals due for this scope; other holders keep shared sources alive. */
  async waitForDisposals(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all(this.#pending);
    }
    const owners = new Set(
      [...this.#registries].flatMap((registry) => resources.owners.get(registry) ?? []),
    );
    await Promise.all([...owners].flatMap((owner) => (owner.completion ? [owner.completion] : [])));
    const failures = [...owners].flatMap((owner) => owner.failures);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Plugin resource scope disposal failed");
    }
  }

  release(): void {
    if (this.#releaseRequested) {
      return;
    }
    this.#releaseRequested = true;
    if (this.#pending.size === 0) {
      this.#finishRelease();
    }
  }

  #finishRelease(): void {
    if (this.#released) {
      return;
    }
    this.#released = true;
    const claims = [...this.#claims.values()];
    this.#claims.clear();
    for (const claim of claims) {
      claim.release();
    }
    this.#releaseCompletion.resolve();
  }
}

const registryResourceScope = resolveGlobalSingleton<
  AsyncLocalStorage<PluginRegistryResourceScope>
>(Symbol.for("openclaw.pluginRegistryResourceScope"), () => new AsyncLocalStorage());

/** Carries an explicit build, run, or host lifetime through nested registry acquisitions. */
export function withPluginRegistryResourceScope<T>(
  scope: PluginRegistryResourceScope,
  run: () => T,
): T {
  scope.assertOpen();
  return registryResourceScope.run(scope, run);
}

export function getPluginRegistryResourceScope(): PluginRegistryResourceScope | undefined {
  return registryResourceScope.getStore();
}

export function requirePluginRegistryResourceScope(): PluginRegistryResourceScope {
  const scope = registryResourceScope.getStore();
  if (!scope) {
    throw new Error("Plugin runtime acquisition requires an explicit resource owner");
  }
  scope.assertRetained();
  return scope;
}

/** Value-only synchronous work; executable return values must retain their caller's owner. */
export function withPluginRegistryResourceOperation<T>(run: () => T): T {
  const inherited = registryResourceScope.getStore();
  if (inherited) {
    inherited.assertRetained();
    return run();
  }
  const scope = new PluginRegistryResourceScope();
  try {
    return withPluginRegistryResourceScope(scope, run);
  } finally {
    scope.release();
  }
}

/** Holds a value-only operation's resources through actual completion, including cancellation. */
export async function withPluginRegistryResourceOperationAsync<T>(
  run: () => Promise<T>,
): Promise<T> {
  const inherited = registryResourceScope.getStore();
  inherited?.assertRetained();
  return await runWithOwnedPluginRegistryResources(
    inherited ? inherited.fork() : new PluginRegistryResourceScope(),
    run,
  );
}

/** Detached owners must re-admit instead of inheriting a completed operation's claims. */
export function runOutsidePluginRegistryResourceScope<T>(run: () => T): T {
  return registryResourceScope.exit(run);
}

/** Synchronous hosts can release after accepted work; shutdown joins the real completion. */
export function releasePluginRegistryResourcesAfter(
  claim: PluginRegistryResourceClaim,
  pending: Promise<unknown>,
): void {
  // The original operation retains its own result/error. This completion owns only release.
  const completion = pending.then(
    () => claim.release(),
    () => claim.release(),
  );
  resources.pending.add(completion);
  void completion.then(() => resources.pending.delete(completion));
}

/** Registers accepted work before invoking it, then releases only after its actual result settles. */
export function runWithOwnedPluginRegistryResources<T>(
  scope: PluginRegistryResourceScope,
  run: () => Promise<T>,
): Promise<T> {
  const completion = createDeferredCore<T>();
  // Release runs before the hold settles, keeping reentrant drains from observing a gap.
  void completion.promise.then(
    () => scope.release(),
    () => scope.release(),
  );
  scope.hold(completion.promise);
  try {
    const parent = registryResourceScope.getStore();
    if (parent && parent !== scope) {
      parent.hold(scope.releaseCompletion);
    }
    completion.resolve(withPluginRegistryResourceScope(scope, run));
  } catch (error) {
    completion.reject(error);
  }
  return completion.promise;
}

/** A callback-bearing acquisition closes admission before draining its accepted work. */
export function createPluginRegistryResourceLease(scope: PluginRegistryResourceScope): {
  run: <T>(operation: () => T) => T;
  release: (pending?: Promise<unknown>) => void;
} {
  let released = false;
  return {
    run(operation) {
      if (released) {
        throw new Error("Plugin registry resource lease has been released");
      }
      const accepted = createDeferredCore<unknown>();
      scope.hold(accepted.promise);
      try {
        const result = scope.run(operation);
        accepted.resolve(isPromiseLike(result) ? result : undefined);
        return result;
      } catch (error) {
        accepted.resolve(undefined);
        throw error;
      }
    },
    release(pending) {
      if (released) {
        return;
      }
      released = true;
      if (pending) {
        releasePluginRegistryResourcesAfter(scope, pending);
      } else {
        scope.release();
      }
    },
  };
}
