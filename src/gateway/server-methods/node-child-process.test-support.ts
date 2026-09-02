/**
 * Test support for gateway methods that spawn node child processes.
 */
import { vi } from "vitest";
import { mockNodeBuiltinModule } from "../../plugin-sdk/test-helpers/node-builtin-mocks.js";

export async function mockNodeChildProcessModule(
  overrides: Partial<typeof import("node:child_process")>,
) {
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    overrides,
  );
}
