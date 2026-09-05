import { AsyncLocalStorage } from "node:async_hooks";

// The plugin entry loads this before Gateway turns are admitted, while managers
// load lazily. Background resources must not retain the turn that opens a
// manager or publishes a transcript update.
export const runInMemoryBackgroundContext = AsyncLocalStorage.snapshot();
