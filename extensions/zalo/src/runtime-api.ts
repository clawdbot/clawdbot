// Internal runtime barrel. Keep this independent from the public top-level
// runtime barrel so local imports do not loop back through the plugin export
// surface during entry loading.
export * from "./runtime-support.js";
export { setZaloRuntime } from "./runtime.js";
