// Vitest media config wires the media test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createMediaVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/media/**/*.test.ts"], {
    dir: "src",
    env,
    name: "media",
    passWithNoTests: true,
  });
}

export default createMediaVitestConfig();
