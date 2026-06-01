import { vi } from "vitest";

export async function mockNodeChildProcessModule(
  overrides: Partial<typeof import("node:child_process")>,
) {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    overrides,
  );
}
