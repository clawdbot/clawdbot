import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { capturePluginLifecycleAuthority } from "../plugins/registry-lifecycle.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** Creation-only authority. Copied fields never identify an initializer to the host. */
export type SessionInitialization = {
  assertCurrent: () => void;
  assertRollbackCurrent: () => void;
  /** Prepares child policy data without constructing tools or acquiring run authority. */
  prepareNativeToolPolicy?: (
    model: SessionNativeToolModel,
  ) => Promise<Readonly<{ webSearchAllowed: boolean }>>;
};

/** Native model selection data; the creation owner fixes every authority-bearing input. */
type SessionNativeToolModel = Readonly<{
  provider: string;
  runtimeProvider?: string;
  id: string;
}>;

type Target = {
  storePath: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
};
type Owner = {
  target: Target;
  handle: SessionInitialization;
  committed: () => void;
};
// Built core chunks and source plugins must redeem the same process-local owner.
const { rollbackOwner, sources } = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionInitialization"),
  () => ({
    rollbackOwner: new AsyncLocalStorage<Owner>(),
    sources: new AsyncLocalStorage<() => void>(),
  }),
);

/** The message-cut owner supplies its exact source incarnation, never plugin-provided fields. */
export async function withSessionInitializationSource<T>(
  assertCurrent: () => void,
  run: () => Promise<T>,
): Promise<T> {
  let active = true;
  try {
    return await sources.run(() => {
      if (!active) {
        throw new Error("Session initialization source is closed");
      }
      assertCurrent();
    }, run);
  } finally {
    active = false;
  }
}

export function captureSessionInitializationOwner(harnessId: string | undefined): () => void {
  const assertSource = sources.getStore();
  const scopedRegistry = () =>
    getPluginRuntimeGenerationRegistry() ?? getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const scoped = scopedRegistry();
  const registry = scoped ?? getPluginRegistryState()?.activeRegistry;
  const registration = registry?.agentHarnesses.find(
    (candidate) => candidate.harness.id === harnessId,
  );
  const record = registry?.plugins.find((candidate) => candidate.id === registration?.pluginId);
  const registryCurrent =
    registry &&
    capturePluginLifecycleAuthority(registry, record, { scopedRuntime: scoped === registry });
  const harness = registration?.harness;
  const deletion = harness?.withSessionDeletion;
  return () => {
    assertSource?.();
    if (
      registry &&
      (!registryCurrent?.() ||
        (scoped && scopedRegistry() !== scoped) ||
        (!scoped && getPluginRegistryState()?.activeRegistry !== registry) ||
        (registration &&
          (!registry.agentHarnesses.includes(registration) ||
            registration.harness !== harness ||
            harness?.withSessionDeletion !== deletion)))
    ) {
      throw new Error("Session initialization registry owner changed");
    }
  };
}

export function createSessionInitialization(
  target: Target,
  assertOwner: (deleted: boolean) => void,
  preparation: { config: OpenClawConfig; agentId: string; entry: SessionEntry },
) {
  const registry =
    getPluginRuntimeGenerationRegistry() ??
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ??
    getPluginRegistryState()?.activeRegistry ??
    undefined;
  let active = true;
  let deleted = false;
  const assertLive = () => {
    if (!active) {
      throw new Error("Session initialization is closed");
    }
    assertOwner(deleted);
  };
  const owner: Owner = {
    target,
    handle: Object.freeze({
      assertCurrent() {
        assertLive();
        if (deleted || rollbackOwner.getStore() === owner) {
          throw new Error("Session initialization is rolling back");
        }
      },
      assertRollbackCurrent() {
        assertLive();
        if (rollbackOwner.getStore() !== owner) {
          throw new Error("Session initialization rollback is not active");
        }
      },
      prepareNativeToolPolicy: async (model: SessionNativeToolModel) => {
        owner.handle.assertCurrent();
        const { provider, runtimeProvider = provider, id } = model;
        if (
          [provider, runtimeProvider, id].some(
            (value) => typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 256,
          )
        ) {
          throw new Error("Session policy preparation requires a bounded native model selection");
        }
        const [
          { resolvePluginHarnessToolPolicies },
          { resolveSandboxRuntimeStatus },
          { resolveWebSearchToolPolicy },
        ] = await Promise.all([
          import("../agents/harness/selection.js"),
          import("../agents/sandbox/runtime-status.js"),
          import("../agents/web-search-tool-policy.js"),
        ]);
        owner.handle.assertCurrent();
        const child = {
          config: preparation.config,
          agentId: preparation.agentId,
          sessionKey: target.sessionKey,
          sessionId: target.sessionId,
        };
        if (
          preparation.entry.execNode ||
          resolveSandboxRuntimeStatus({
            cfg: child.config,
            agentId: child.agentId,
            sessionKey: child.sessionKey,
          }).sandboxed
        ) {
          throw new Error(
            "Session creation cannot prepare an execution environment; fork from the original source instead.",
          );
        }
        const result = withPluginRuntimeGatewayRequestScope(
          { isWebchatConnect: () => false, pluginRegistry: registry },
          () => {
            const policy = resolvePluginHarnessToolPolicies({
              ...child,
              provider: runtimeProvider,
              modelId: id,
            });
            if (policy.toolPolicyRestricted) {
              throw new Error(
                "The child's native tool policy requires run-owned preparation. Fork an original imported message instead.",
              );
            }
            return {
              webSearchAllowed: resolveWebSearchToolPolicy({
                ...child,
                modelProvider: provider,
                modelId: id,
                webSearchEnabled: child.config.tools?.web?.search?.enabled,
              }).persistentAllowed,
            };
          },
        );
        owner.handle.assertCurrent();
        return result;
      },
    }),
    committed: () => {
      deleted = true;
    },
  };
  return {
    handle: owner.handle,
    rollback: <T>(run: () => Promise<T>) => rollbackOwner.run(owner, run),
    close: () => {
      active = false;
    },
  };
}

export function getSessionInitializationRollback(
  target: Target,
): SessionInitialization | undefined {
  const owner = rollbackOwner.getStore();
  if (
    !owner ||
    owner.target.storePath !== target.storePath ||
    owner.target.sessionKey !== target.sessionKey ||
    owner.target.sessionId !== target.sessionId ||
    owner.target.lifecycleRevision !== target.lifecycleRevision
  ) {
    return undefined;
  }
  owner.handle.assertRollbackCurrent();
  return owner.handle;
}

/** Called by the first deletion publication, only for a removal that crossed COMMIT. */
export function commitSessionInitializationRollback(handle: SessionInitialization): void {
  const owner = rollbackOwner.getStore();
  if (owner?.handle === handle) {
    owner.committed();
  }
}
