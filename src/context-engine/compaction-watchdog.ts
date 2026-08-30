// Compaction watchdog ownership must survive registry projection proxies and duplicate dist chunks.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { ContextEngine } from "./types.js";

const RUNTIME_COMPACTION_DELEGATES = Symbol.for("openclaw.runtimeCompactionDelegates");
const runtimeCompactionDelegates = resolveGlobalSingleton<WeakSet<ContextEngine["compact"]>>(
  RUNTIME_COMPACTION_DELEGATES,
  () => new WeakSet(),
);

export function markRuntimeCompactionDelegate<T extends ContextEngine["compact"]>(compact: T): T {
  runtimeCompactionDelegates.add(compact);
  return compact;
}

export function inheritRuntimeCompactionDelegate(
  source: ContextEngine["compact"],
  wrapped: ContextEngine["compact"],
): ContextEngine["compact"] {
  return runtimeCompactionDelegates.has(source) ? markRuntimeCompactionDelegate(wrapped) : wrapped;
}

export function bindContextEngineCompaction(owner: {
  readonly compact: ContextEngine["compact"];
}): ContextEngine["compact"] {
  // Projection proxies can return a fresh method on each read. Bind and tag
  // the same captured method so watchdog ownership matches the invoked backend.
  const compact = owner.compact;
  return inheritRuntimeCompactionDelegate(compact, compact.bind(owner));
}

export function isRuntimeCompactionDelegate(compact: ContextEngine["compact"]): boolean {
  return runtimeCompactionDelegates.has(compact);
}
