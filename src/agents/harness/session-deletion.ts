import { capturePluginLifecycleAuthority } from "../../plugins/registry-lifecycle.js";
import { getPluginRegistryState } from "../../plugins/runtime-state.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../../plugins/runtime/generation-scope.js";
import type {
  AgentHarnessSessionDeletionMutation,
  AgentHarnessSessionDeletionParams,
} from "./types.js";

export type AgentHarnessSessionDeletionTarget = Omit<
  AgentHarnessSessionDeletionParams,
  "assertCurrent"
> & { agentHarnessId?: string };
export type PreparedAgentHarnessSessionDeletion = AgentHarnessSessionDeletionMutation & {
  assertCurrent: () => void;
};

/** Reuse the registered harness owner; deletion is not a second plugin registration surface. */
export function captureAgentHarnessSessionDeletions() {
  const scopedRegistry = () =>
    getPluginRuntimeGenerationRegistry() ?? getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const scoped = scopedRegistry();
  const registry = scoped ?? getPluginRegistryState()?.activeRegistry;
  const owners =
    registry?.agentHarnesses.flatMap((registration) => {
      const prepare = registration.harness.withSessionDeletion;
      if (!prepare) {
        return [];
      }
      const record = registry.plugins.find((plugin) => plugin.id === registration.pluginId);
      const current =
        record || registration.pluginId === "core"
          ? capturePluginLifecycleAuthority(registry, record, {
              scopedRuntime: scoped === registry,
            })
          : undefined;
      return [{ registration, prepare, current }];
    }) ?? [];
  return owners.length === 0
    ? undefined
    : async <T>(
        targets: readonly AgentHarnessSessionDeletionTarget[],
        run: (
          prepared: ReadonlyMap<string, readonly PreparedAgentHarnessSessionDeletion[]>,
        ) => Promise<T>,
      ): Promise<T> => {
        const pending = targets.flatMap((target) =>
          owners
            .filter(
              ({ registration }) =>
                !target.agentHarnessId || target.agentHarnessId === registration.harness.id,
            )
            .map((owner) => ({ owner, target })),
        );
        const prepared = new Map<string, PreparedAgentHarnessSessionDeletion[]>();
        const prepareNext = async (index: number): Promise<T> => {
          const candidate = pending[index];
          if (!candidate) {
            return await run(prepared);
          }
          const { owner, target } = candidate;
          let active = true;
          const assertCurrent = () => {
            if (
              !active ||
              !owner.current?.() ||
              (scoped && scopedRegistry() !== scoped) ||
              !registry?.agentHarnesses.includes(owner.registration) ||
              owner.registration.harness.withSessionDeletion !== owner.prepare
            ) {
              throw new Error(
                `Session deletion harness owner changed: ${owner.registration.harness.id}`,
              );
            }
          };
          try {
            assertCurrent();
            const result = await owner.prepare<T>(
              { ...target, assertCurrent },
              async (mutation) => {
                assertCurrent();
                const mutations = prepared.get(target.sessionKey) ?? [];
                mutations.push({
                  assertCurrent,
                  commit: () => {
                    assertCurrent();
                    mutation.commit();
                  },
                  rollback: () => {
                    assertCurrent();
                    mutation.rollback();
                  },
                });
                prepared.set(target.sessionKey, mutations);
                return await prepareNext(index + 1);
              },
            );
            assertCurrent();
            return result;
          } finally {
            active = false;
          }
        };
        return await prepareNext(0);
      };
}
