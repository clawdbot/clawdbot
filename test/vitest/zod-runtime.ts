// Test-only zod entry: zod's real index.js re-exports the `z` namespace via
// `import * as z; export { z }`, which Bun's module linker drops when Vitest's
// loader hooks are active (named `z` arrives undefined). Re-exporting through a
// const binding links correctly on both Node and Bun; the exposed surface is
// identical to `zod` (zod/v4 is the same classic API), so Node is unchanged.
import * as zNamespace from "zod/v4";

export * from "zod/v4";
export const z = zNamespace;
export default zNamespace;
