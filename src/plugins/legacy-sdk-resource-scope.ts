/** Host ownership for deprecated SDK APIs whose shipped return value has no release method. */
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  PluginRegistryResourceScope,
  withPluginRegistryResourceScope,
} from "./registry-resources.js";

type LegacySdkClaim = { release(): void | Promise<void> };

type LegacySdkGeneration = {
  resources: PluginRegistryResourceScope;
  claims: Set<LegacySdkClaim>;
  operations: Set<Promise<unknown>>;
  closed: boolean;
  closePromise?: Promise<void>;
};

function createLegacySdkGeneration(): LegacySdkGeneration {
  return {
    resources: new PluginRegistryResourceScope(),
    claims: new Set<LegacySdkClaim>(),
    operations: new Set<Promise<unknown>>(),
    closed: false,
  };
}

const legacyPluginSdkHost = resolveGlobalSingleton(
  Symbol.for("openclaw.legacyPluginSdkRegistryResourceHost"),
  () => ({ generation: createLegacySdkGeneration() }),
  async (host) => {
    const generation = host.generation;
    generation.closed = true;
    generation.closePromise ??= Promise.resolve().then(async () => {
      // Closing ends admission; already admitted operations still own their resources.
      while (generation.operations.size > 0) {
        await Promise.allSettled(generation.operations);
      }
      const claims = [...generation.claims];
      generation.claims.clear();
      const results = await Promise.allSettled(claims.map(async (claim) => await claim.release()));
      generation.resources.release();
      results.push(...(await Promise.allSettled([generation.resources.waitForDisposals()])));
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Legacy plugin SDK host resource release failed");
      }
    });
    await generation.closePromise;
    if (host.generation === generation) {
      host.generation = createLegacySdkGeneration();
    }
  },
);

/** Only deprecated SDK facades may use this owner; standalone hosts retain until process exit. */
export function withLegacyPluginSdkResourceScope<T>(
  run: (
    resources: PluginRegistryResourceScope,
    retain: (claim: LegacySdkClaim) => void,
    runInHost: <TResult>(run: () => TResult) => TResult,
  ) => T,
): T {
  const generation = legacyPluginSdkHost.generation;
  const { resources, claims, operations } = generation;
  const retain = (claim: LegacySdkClaim) => {
    if (generation.closed) {
      // Keep a late-created lease in this closing generation so its actual release is joined.
      claims.add(claim);
      throw new Error("Legacy plugin SDK host is closed");
    }
    resources.assertOpen();
    claims.add(claim);
  };
  const runInHost = <TResult>(operation: () => TResult): TResult => {
    if (generation.closed) {
      throw new Error("Legacy plugin SDK host is closed");
    }
    resources.assertOpen();
    const result = withPluginRegistryResourceScope(resources, operation);
    if (isPromiseLike(result)) {
      const completion = Promise.resolve(result);
      operations.add(completion);
      void completion.then(
        () => operations.delete(completion),
        () => operations.delete(completion),
      );
    }
    return result;
  };
  return runInHost(() => run(resources, retain, runInHost));
}
