import { createLazyPromiseLoader } from "../shared/lazy-runtime.js";

const typescriptRuntimeLoader = createLazyPromiseLoader(() => import("typescript"), {
  cacheRejections: true,
});

export function loadCodeModeTypeScriptRuntime(): Promise<typeof import("typescript")> {
  return typescriptRuntimeLoader.load();
}
