import { isDeepStrictEqual } from "node:util";
import type { AgentHarnessSessionDeletionParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  deleteSessionUpstreamLink,
  upsertSessionUpstreamLink,
} from "openclaw/plugin-sdk/session-catalog";
import {
  validateBindingForWrite,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";

type Initialization = NonNullable<AgentHarnessSessionDeletionParams["initialization"]>;
type Ownership = {
  store: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  binding?: CodexAppServerThreadBinding;
  assertCleanupAllowed?: () => void;
  cleanup: () => Promise<void>;
};
const initializations = new WeakMap<Initialization, Ownership>();

/** Associate the host's exact handle before any potentially committing plugin write. */
export function prepareCodexSessionInitialization(params: {
  initialization: Initialization;
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  prepareCleanup?: () => (assertCurrent: () => void) => Promise<void>;
  assertCleanupAllowed?: () => void;
}) {
  const { initialization, bindingStore, identity } = params;
  initialization.assertCurrent();
  let link:
    | NonNullable<NonNullable<Parameters<typeof deleteSessionUpstreamLink>[2]>["expected"]>
    | undefined;
  const ownership: Ownership = {
    store: bindingStore,
    identity: structuredClone(identity),
    assertCleanupAllowed: params.assertCleanupAllowed,
    cleanup: async () => {
      initialization.assertRollbackCurrent();
      if (
        link &&
        deleteSessionUpstreamLink(link.sessionKey, link.agentId, {
          expected: link,
          assertCommitAllowed: initialization.assertRollbackCurrent,
        }) === "changed"
      ) {
        throw new Error("Codex initialization link changed before cleanup");
      }
      initialization.assertRollbackCurrent();
      await cleanup?.(initialization.assertRollbackCurrent);
      initialization.assertRollbackCurrent();
    },
  };
  initializations.set(initialization, ownership);
  const cleanup = params.prepareCleanup?.();
  return {
    assertCurrent: initialization.assertCurrent,
    async bind(binding: CodexAppServerThreadBinding) {
      initialization.assertCurrent();
      ownership.binding = validateBindingForWrite(binding);
      const stored = await bindingStore.mutate(
        identity,
        {
          kind: "set",
          if: { kind: "absent" },
          binding: ownership.binding,
        },
        initialization.assertCurrent,
      );
      if (!stored) {
        ownership.binding = undefined;
        throw new Error("Codex session binding changed during initialization");
      }
      initialization.assertCurrent();
    },
    link(input: Parameters<typeof upsertSessionUpstreamLink>[0]) {
      initialization.assertCurrent();
      const now = Date.now();
      link = structuredClone({ ...input, createdAt: now, updatedAt: now });
      if (
        !upsertSessionUpstreamLink(input, {
          now,
          ifAbsent: true,
          assertCommitAllowed: initialization.assertCurrent,
        })
      ) {
        link = undefined;
        throw new Error("Codex initialization link could not be persisted");
      }
      initialization.assertCurrent();
    },
  };
}

export function getCodexSessionInitializationRollback(
  store: CodexAppServerBindingStore,
  params: AgentHarnessSessionDeletionParams,
  identity: CodexAppServerBindingIdentity,
  binding: CodexAppServerThreadBinding | undefined,
): (() => Promise<void>) | undefined {
  const handle = params.initialization;
  if (!handle) {
    return undefined;
  }
  handle.assertRollbackCurrent();
  const ownership = initializations.get(handle);
  if (!ownership && !binding) {
    return undefined;
  }
  if (
    !ownership ||
    ownership.store !== store ||
    !isDeepStrictEqual(ownership.identity, identity) ||
    (binding && !isDeepStrictEqual(ownership.binding, binding))
  ) {
    throw new Error("Codex initialization binding owner changed before rollback");
  }
  // Reject indeterminate native work before either local deletion commits.
  ownership.assertCleanupAllowed?.();
  return ownership.cleanup;
}
