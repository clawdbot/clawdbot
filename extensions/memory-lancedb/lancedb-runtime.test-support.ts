type LanceDbModule = typeof import("@lancedb/lancedb");

type LanceDbRuntimeTestApi = {
  createRuntimeLoader: (overrides?: {
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    importBundled?: () => Promise<LanceDbModule>;
  }) => { load: () => Promise<LanceDbModule> };
};

const api = Reflect.get(globalThis, Symbol.for("openclaw.memoryLanceDbRuntimeTestApi"));
if (!api) {
  throw new Error("Memory LanceDB runtime test API is unavailable");
}

export const createLanceDbRuntimeLoader = (api as LanceDbRuntimeTestApi).createRuntimeLoader;
