// Owns atomic plugin registration state across registry and process-global capabilities.
import {
  listRegisteredAgentHarnesses,
  restoreRegisteredAgentHarnesses,
} from "../agents/harness/registry.js";
import {
  getDetachedTaskLifecycleRuntimeRegistration,
  restoreDetachedTaskLifecycleRuntimeRegistration,
} from "../tasks/detached-task-runtime-state.js";
import { listRegisteredPluginCommands, restorePluginCommands } from "./command-registry-state.js";
import {
  listRegisteredCompactionProviders,
  restoreRegisteredCompactionProviders,
} from "./compaction-provider.js";
import {
  listRegisteredEmbeddingProviders,
  restoreRegisteredEmbeddingProviders,
} from "./embedding-providers.js";
import {
  listPluginInteractiveHandlers,
  restorePluginInteractiveHandlers,
} from "./interactive-registry.js";
import {
  listRegisteredMemoryEmbeddingProviders,
  restoreRegisteredMemoryEmbeddingProviders,
} from "./memory-embedding-providers.js";
import {
  getMemoryCapabilityRegistration,
  listMemoryCorpusSupplements,
  listMemoryPromptPreparations,
  listMemoryPromptSupplements,
  restoreMemoryPluginState,
} from "./memory-state.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  getSessionDiscussionProvider,
  restoreSessionDiscussionProvider,
} from "./session-discussion-registry.js";

export type PluginProcessGlobalState = {
  agentHarnesses: ReturnType<typeof listRegisteredAgentHarnesses>;
  commands: ReturnType<typeof listRegisteredPluginCommands>;
  compactionProviders: ReturnType<typeof listRegisteredCompactionProviders>;
  detachedTaskRuntimeRegistration: ReturnType<typeof getDetachedTaskLifecycleRuntimeRegistration>;
  embeddingProviders: ReturnType<typeof listRegisteredEmbeddingProviders>;
  interactiveHandlers: ReturnType<typeof listPluginInteractiveHandlers>;
  memoryCapability: ReturnType<typeof getMemoryCapabilityRegistration>;
  memoryCorpusSupplements: ReturnType<typeof listMemoryCorpusSupplements>;
  memoryEmbeddingProviders: ReturnType<typeof listRegisteredMemoryEmbeddingProviders>;
  memoryPromptPreparations: ReturnType<typeof listMemoryPromptPreparations>;
  memoryPromptSupplements: ReturnType<typeof listMemoryPromptSupplements>;
  sessionDiscussionProvider: ReturnType<typeof getSessionDiscussionProvider>;
};

export function snapshotPluginProcessGlobalState(): PluginProcessGlobalState {
  return {
    agentHarnesses: listRegisteredAgentHarnesses(),
    commands: listRegisteredPluginCommands(),
    compactionProviders: listRegisteredCompactionProviders(),
    detachedTaskRuntimeRegistration: getDetachedTaskLifecycleRuntimeRegistration(),
    embeddingProviders: listRegisteredEmbeddingProviders(),
    interactiveHandlers: listPluginInteractiveHandlers(),
    memoryCapability: getMemoryCapabilityRegistration(),
    memoryCorpusSupplements: listMemoryCorpusSupplements(),
    memoryEmbeddingProviders: listRegisteredMemoryEmbeddingProviders(),
    memoryPromptPreparations: listMemoryPromptPreparations(),
    memoryPromptSupplements: listMemoryPromptSupplements(),
    sessionDiscussionProvider: getSessionDiscussionProvider(),
  };
}

export function restorePluginProcessGlobalState(state: PluginProcessGlobalState): void {
  restoreRegisteredAgentHarnesses(state.agentHarnesses);
  restorePluginCommands(state.commands);
  restoreRegisteredCompactionProviders(state.compactionProviders);
  restoreDetachedTaskLifecycleRuntimeRegistration(state.detachedTaskRuntimeRegistration);
  restoreRegisteredEmbeddingProviders(state.embeddingProviders);
  restorePluginInteractiveHandlers(state.interactiveHandlers);
  restoreRegisteredMemoryEmbeddingProviders(state.memoryEmbeddingProviders);
  restoreMemoryPluginState({
    capability: state.memoryCapability,
    corpusSupplements: state.memoryCorpusSupplements,
    promptPreparations: state.memoryPromptPreparations,
    promptSupplements: state.memoryPromptSupplements,
  });
  restoreSessionDiscussionProvider(state.sessionDiscussionProvider);
}

/**
 * Shallow-clone a registration record so metadata mutations do not leak
 * through rollback, while preserving opaque plugin-owned instances
 * (providers, services, channels, harnesses, resolvers) by reference.
 *
 * A generic recursive deep-clone would convert every plugin-owned object
 * into a plain object, losing prototypes, internal slots, symbols, and
 * shared identity. Shallow-cloning is correct here because the mutable
 * fields on registration records are primitives (strings, numbers,
 * booleans, Dates), and the opaque fields are class instances that the
 * registry must not reconstitute.
 */
function cloneRegistryEntry(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneRegistryEntry(item));
  }
  if (value instanceof Map) {
    return new Map([...value].map(([k, v]) => [k, cloneRegistryEntry(v)]));
  }
  if (value instanceof Date) {
    return new Date(value);
  }
  // Shallow-clone so primitive metadata fields become independent copies
  // while opaque plugin-owned objects stay by reference.
  const cloned: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const val = (value as Record<string, unknown>)[key];
    if (val instanceof Date) {
      cloned[key] = new Date(val);
    } else if (Array.isArray(val)) {
      cloned[key] = [...val];
    } else {
      cloned[key] = val;
    }
  }
  return cloned;
}

function snapshotPluginRegistry(registry: PluginRegistry): PluginRegistry {
  return Object.fromEntries(
    Object.entries(registry).map(([key, value]) => {
      if (Array.isArray(value)) {
        return [key, value.map((item) => cloneRegistryEntry(item))];
      }
      if (value instanceof Map) {
        return [key, new Map([...value].map(([k, v]) => [k, cloneRegistryEntry(v)]))];
      }
      if (value && typeof value === "object") {
        return [key, cloneRegistryEntry(value)];
      }
      return [key, value];
    }),
  ) as PluginRegistry;
}

function restorePluginRegistry(registry: PluginRegistry, snapshot: PluginRegistry): void {
  Object.assign(registry, snapshot);
}

/**
 * Snapshot of the active PluginRecord's transaction-owned mutable fields.
 * Captured with cloneRegistryEntry so arrays, Dates, and primitives become
 * independent copies while runtime objects (configUiHints, configJsonSchema,
 * contracts) stay by reference.
 */
type ActiveRecordSnapshot = Record<string, unknown>;

function snapshotActiveRecord(record: PluginRecord): ActiveRecordSnapshot {
  return cloneRegistryEntry(record) as ActiveRecordSnapshot;
}

function restoreActiveRecord(record: PluginRecord, snapshot: ActiveRecordSnapshot): void {
  // Registration may create optional metadata that did not exist when the
  // transaction began. Remove the live shape before restoring the snapshot.
  for (const key of Object.keys(record)) {
    Reflect.deleteProperty(record, key);
  }
  Object.assign(record, snapshot);
}

type PluginRegistrationTransaction = {
  commit: (params: { activate: boolean }) => void;
  rollback: () => void;
};

export function createPluginRegistrationTransaction(params: {
  registry?: PluginRegistry;
  rollbackGlobalSideEffects?: () => void;
  /** Active PluginRecord being registered by the caller (mutated during
   *  register() before being pushed to registry.plugins).  When set, its
   *  mutable metadata fields (arrays, scalars, flags, Dates) are snapshotted
   *  and restored on rollback while runtime objects keep their identity. */
  activeRecord?: PluginRecord;
}): PluginRegistrationTransaction {
  const registrySnapshot = params.registry ? snapshotPluginRegistry(params.registry) : undefined;
  const processGlobalState = snapshotPluginProcessGlobalState();
  const activeRecordSnapshot = params.activeRecord
    ? snapshotActiveRecord(params.activeRecord)
    : null;
  let settled = false;

  const settle = (action: () => void): void => {
    if (settled) {
      return;
    }
    action();
    settled = true;
  };

  return {
    commit: ({ activate }) => {
      settle(() => {
        if (!activate) {
          restorePluginProcessGlobalState(processGlobalState);
        }
      });
    },
    rollback: () => {
      settle(() => {
        params.rollbackGlobalSideEffects?.();
        if (params.registry && registrySnapshot) {
          restorePluginRegistry(params.registry, registrySnapshot);
        }
        restorePluginProcessGlobalState(processGlobalState);
        if (activeRecordSnapshot && params.activeRecord) {
          restoreActiveRecord(params.activeRecord, activeRecordSnapshot);
        }
      });
    },
  };
}
