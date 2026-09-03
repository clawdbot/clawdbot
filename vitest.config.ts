// Root Vitest config wires the repository Vitest project matrix.
export {
  default,
  resolveDefaultVitestPool,
  resolveLocalVitestMaxWorkers,
  resolveLocalVitestScheduling,
} from "./test/vitest/vitest.config.ts";
