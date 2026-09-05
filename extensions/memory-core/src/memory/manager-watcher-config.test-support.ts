import type {
  MemorySearchConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

export type WatchIgnoredFn = (
  watchPath: string,
  stats?: { isDirectory?: () => boolean },
) => boolean;

const originalWatcherStateDir = process.env.OPENCLAW_STATE_DIR;

export function setWatcherStateDir(stateDir: string): void {
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
}

export function createWatcherConfigFixture(
  workspaceDir: string,
  extraDir: string,
  overrides?: Partial<MemorySearchConfig>,
): OpenClawConfig {
  return isolateMemoryManagerTestConfig({
    memory: {
      search: {
        provider: "openai",
        model: "mock-embed",
        store: { vector: { enabled: false } },
        query: { minScore: 0 },
        extraPaths: [extraDir],
        ...overrides,
      },
    },
    agents: { entries: { main: { workspace: workspaceDir } } },
  });
}

export function restoreWatcherStateDir(): void {
  if (originalWatcherStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalWatcherStateDir);
  }
}
