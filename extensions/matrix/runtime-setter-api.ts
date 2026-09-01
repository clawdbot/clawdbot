// Narrow entry point for setMatrixRuntime. The full runtime-api barrel is kept
// for external/runtime callers, but bundled plugin register only needs this.
export { setMatrixRuntime } from "./src/runtime.js";
