// Matrix API module exposes the plugin public contract.
export {
  createMatrixThreadBindingManager,
  resetMatrixThreadBindingsForTests,
} from "./src/matrix/thread-bindings.js";
export { setMatrixRuntime } from "./src/runtime.js";
